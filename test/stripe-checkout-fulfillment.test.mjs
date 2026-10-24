import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import test from "node:test";
import { fulfillStripeCheckoutWebhook } from "../src/stripe-checkout-fulfillment.mjs";
import { createDurableFulfillment, DigitalGoodsFulfillment } from "../src/durable-fulfillment.mjs";

const secret = "offline-webhook-fixture";
const checkout = { sessionId: "cs_fixture", offeringId: "fixture-book", requestDigest: "fixture-digest", amountTotal: 1200, currency: "usd", stripeMode: "test", goods: [] };
function event(type = "checkout.session.async_payment_succeeded", overrides = {}) {
  return { id: "evt_async", type, livemode: false, data: { object: { id: checkout.sessionId, amount_total: checkout.amountTotal, currency: checkout.currency, payment_status: "paid", status: "complete", payment_intent: "pi_fixture", metadata: { offering_id: checkout.offeringId, request_digest: checkout.requestDigest }, ...overrides } } };
}
function request(value, signingSecret = secret) {
  const body = JSON.stringify(value), timestamp = Math.floor(Date.now() / 1000);
  const signature = createHmac("sha256", signingSecret).update(`${timestamp}.${body}`).digest("hex");
  return new Request("https://shop.test/webhooks/stripe", { method: "POST", body, headers: { "stripe-signature": `t=${timestamp},v1=${signature}` } });
}
async function fixture() {
  const rows = new Map();
  const storage = { async get(key) { return rows.get(key); }, async put(key, value) { rows.set(key, value); }, async transaction(work) { return work(storage); } };
  const runtime = new DigitalGoodsFulfillment({ storage });
  const fulfillment = createDurableFulfillment({ idFromName: () => "fixture", get: () => ({ fetch: (url, init) => runtime.fetch(new Request(url, init)) }) }, "fixture");
  await fulfillment.recordCheckout(checkout);
  return { rows, fulfillment, env: { fulfillment, STRIPE_WEBHOOK_SECRET: secret } };
}

test("a delayed paid event fulfills through the real Stripe signature and durable store", async () => {
  const f = await fixture();
  const response = await fulfillStripeCheckoutWebhook(request(event()), f.env);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { accepted: true, duplicate: false });
  assert.equal((await f.fulfillment.getEntitlement(checkout.sessionId)).status, "active");
  assert.equal(f.rows.get("event:evt_async").type, "checkout.session.async_payment_succeeded");
});

test("signed payment event ID cannot silently become the duplicate of another checkout session", async () => {
  const f = await fixture();
  await f.fulfillment.recordCheckout({ ...checkout, sessionId: "cs_second" });
  const first = await fulfillStripeCheckoutWebhook(request(event()), f.env);
  assert.equal(first.status, 200);
  const changed = await fulfillStripeCheckoutWebhook(request(event(undefined, { id: "cs_second" })), f.env);
  assert.equal(changed.status, 409);
  assert.deepEqual(await changed.json(), { error: "payment-does-not-match-checkout-intent" });
  assert.equal(await f.fulfillment.getEntitlement("cs_second"), null);
  assert.equal((await f.fulfillment.getEntitlement(checkout.sessionId)).status, "active");
  assert.equal(f.rows.get("event:evt_async")?.sessionId, checkout.sessionId);
  const exactRetry = await fulfillStripeCheckoutWebhook(request(event()), f.env);
  assert.deepEqual(await exactRetry.json(), { accepted: true, duplicate: true });
});

test("signed payment event ID cannot be reused with a different Checkout event type", async () => {
  const f = await fixture();
  const first = await fulfillStripeCheckoutWebhook(request(event()), f.env);
  assert.equal(first.status, 200);
  const changed = await fulfillStripeCheckoutWebhook(request(event("checkout.session.completed")), f.env);
  assert.equal(changed.status, 409);
  assert.deepEqual(await changed.json(), { error: "payment-does-not-match-checkout-intent" });
  assert.equal(f.rows.get("event:evt_async")?.type, "checkout.session.async_payment_succeeded");
  assert.equal([...f.rows.keys()].filter(key => key.startsWith("entitlement:")).length, 1);
});

test("unpaid completion cannot fulfill, then delayed success does", async () => {
  const f = await fixture();
  const pending = { ...event("checkout.session.completed", { payment_status: "unpaid" }), id: "evt_pending" };
  const accepted = await fulfillStripeCheckoutWebhook(request(pending), f.env);
  assert.equal(accepted.status, 200);
  assert.deepEqual(await accepted.json(), { accepted: true, pending: true });
  assert.equal(await f.fulfillment.getEntitlement(checkout.sessionId), null);
  assert.equal(f.rows.get("event:evt_pending")?.pending, true);
  const repeated = await fulfillStripeCheckoutWebhook(request(pending), f.env);
  assert.deepEqual(await repeated.json(), { accepted: true, duplicate: true });
  assert.equal((await fulfillStripeCheckoutWebhook(request(event()), f.env)).status, 200);
  assert.equal((await f.fulfillment.getEntitlement(checkout.sessionId)).status, "active");
});

test("duplicate and differently identified successful events retain one entitlement", async () => {
  const f = await fixture();
  await fulfillStripeCheckoutWebhook(request(event()), f.env);
  const original = structuredClone(await f.fulfillment.getEntitlement(checkout.sessionId));
  for (const paid of [event(), { ...event("checkout.session.completed"), id: "evt_immediate" }, { ...event(), id: "evt_async_again" }]) {
    const response = await fulfillStripeCheckoutWebhook(request(paid), f.env);
    assert.deepEqual(await response.json(), { accepted: true, duplicate: true });
    assert.deepEqual(await f.fulfillment.getEntitlement(checkout.sessionId), original);
  }
  assert.equal([...f.rows.keys()].filter(k => k.startsWith("entitlement:")).length, 1);
});

test("late unpaid completion does not undo earlier delayed success", async () => {
  const f = await fixture(); await fulfillStripeCheckoutWebhook(request(event()), f.env);
  const late = { ...event("checkout.session.completed", { payment_status: "unpaid" }), id: "evt_late" };
  assert.equal((await fulfillStripeCheckoutWebhook(request(late), f.env)).status, 200);
  assert.equal((await f.fulfillment.getEntitlement(checkout.sessionId)).status, "active");
});

for (const [name, change] of [
  ["unpaid", { payment_status: "unpaid" }],
  ["incomplete", { status: "open" }],
  ["wrong amount", { amount_total: 1 }],
  ["wrong currency", { currency: "eur" }],
  ["unknown session", { id: "cs_other" }],
  ["wrong offering", { metadata: { offering_id: "other-book", request_digest: checkout.requestDigest } }],
  ["wrong request", { metadata: { offering_id: checkout.offeringId, request_digest: "other-digest" } }],
]) test(`delayed success refuses ${name} without recording fulfillment`, async () => {
  const f = await fixture();
  assert.equal((await fulfillStripeCheckoutWebhook(request(event(undefined, change)), f.env)).status, 409);
  assert.equal(await f.fulfillment.getEntitlement(checkout.sessionId), null);
  assert.equal(f.rows.has("event:evt_async"), false);
});

test("live and test receipts never cross their checkout mode", async () => {
  const f = await fixture();
  assert.equal((await fulfillStripeCheckoutWebhook(request({ ...event(), livemode: true }), f.env)).status, 409);
  assert.equal(await f.fulfillment.getEntitlement(checkout.sessionId), null);
  await f.fulfillment.recordCheckout({ ...checkout, sessionId: "cs_live", stripeMode: "live" });
  assert.equal((await fulfillStripeCheckoutWebhook(request(event(undefined, { id: "cs_live" })), f.env)).status, 409);
  assert.equal(await f.fulfillment.getEntitlement("cs_live"), null);
});

test("invalid signatures and missing live/test identity refuse delayed events", async () => {
  const f = await fixture();
  assert.equal((await fulfillStripeCheckoutWebhook(request(event(), "wrong"), f.env)).status, 400);
  const malformed = event(); delete malformed.livemode;
  assert.equal((await fulfillStripeCheckoutWebhook(request(malformed), f.env)).status, 409);
  assert.equal(await f.fulfillment.getEntitlement(checkout.sessionId), null);
});

test("unrelated and failed payment events cannot create an entitlement", async () => {
  const f = await fixture();
  for (const type of ["checkout.session.async_payment_failed", "payment_intent.succeeded", "charge.refunded"]) {
    assert.equal((await fulfillStripeCheckoutWebhook(request(event(type)), f.env)).status, 200);
  }
  assert.equal(await f.fulfillment.getEntitlement(checkout.sessionId), null);
  assert.equal(f.rows.has("event:evt_async"), false);
});

test("a later delayed success never reactivates a revoked purchase", async () => {
  const f = await fixture(); await fulfillStripeCheckoutWebhook(request(event()), f.env);
  await f.fulfillment.revokeEntitlement({ id: checkout.sessionId, paymentIntentId: "pi_fixture", reason: "fixture withdrawal" });
  const response = await fulfillStripeCheckoutWebhook(request({ ...event(), id: "evt_later" }), f.env);
  assert.equal(response.status, 200);
  assert.equal((await f.fulfillment.getEntitlement(checkout.sessionId)).status, "revoked");
});

test("storage failure requests retry and a subsequent delayed event succeeds", async () => {
  const f = await fixture();
  const failed = { ...f.env, fulfillment: { ...f.fulfillment, claimPayment: async () => ({ failed: true }) } };
  assert.equal((await fulfillStripeCheckoutWebhook(request(event()), failed)).status, 503);
  assert.equal((await fulfillStripeCheckoutWebhook(request(event()), f.env)).status, 200);
});

test("body bounds are enforced before Stripe signature processing", async () => {
  const f = await fixture();
  assert.equal((await fulfillStripeCheckoutWebhook(new Request("https://shop.test/webhooks/stripe", { method: "POST", body: "x".repeat(1024 * 1024 + 1) }), f.env)).status, 413);
});

test("streamed Stripe webhook refuses oversize bytes before signature and durable receiving", async () => {
  const f = await fixture();
  const chunk = new Uint8Array(256 * 1024).fill(0x78);
  const body = new ReadableStream({ start(controller) {
    for (let n = 0; n < 5; n++) controller.enqueue(chunk);
    controller.close();
  } });
  const request = new Request("https://shop.test/webhooks/stripe", { method: "POST",
    body, duplex: "half" });
  const response = await fulfillStripeCheckoutWebhook(request, f.env);
  assert.equal(response.status, 413);
  assert.deepEqual(await response.json(), { error: "stripe-webhook-body-too-large" });
  assert.equal(await f.fulfillment.getEntitlement(checkout.sessionId), null);
});

test("streamed Stripe webhook retains exact signed multibyte UTF-8 across chunks", async () => {
  const f = await fixture();
  const paid = event("checkout.session.async_payment_succeeded",
    { metadata: { offering_id: checkout.offeringId, request_digest: checkout.requestDigest, memo: "雪" } });
  const rawBody = JSON.stringify(paid);
  const timestamp = Math.floor(Date.now() / 1000);
  const signature = createHmac("sha256", secret).update(`${timestamp}.${rawBody}`).digest("hex");
  const encoded = new TextEncoder().encode(rawBody), split = encoded.indexOf(0xe9) + 1;
  assert.ok(split > 0);
  const body = new ReadableStream({ start(controller) {
    controller.enqueue(encoded.slice(0, split));
    controller.enqueue(encoded.slice(split));
    controller.close();
  } });
  const request = new Request("https://shop.test/webhooks/stripe", { method: "POST",
    headers: { "stripe-signature": `t=${timestamp},v1=${signature}` },
    body, duplex: "half" });
  const response = await fulfillStripeCheckoutWebhook(request, f.env);
  assert.equal(response.status, 200);
  assert.equal((await f.fulfillment.getEntitlement(checkout.sessionId)).status, "active");
});

test("signed UTF-8 BOM is kept byte-exact until separate JSON admission", async () => {
  const f = await fixture();
  const rawBody = "\uFEFF" + JSON.stringify(event());
  const timestamp = Math.floor(Date.now() / 1000);
  const signature = createHmac("sha256", secret).update(`${timestamp}.${rawBody}`).digest("hex");
  const encoded = new TextEncoder().encode(rawBody);
  assert.deepEqual([...encoded.slice(0, 3)], [0xef, 0xbb, 0xbf]);
  const body = new ReadableStream({ start(controller) {
    controller.enqueue(encoded.slice(0, 1));
    controller.enqueue(encoded.slice(1, 2));
    controller.enqueue(encoded.slice(2));
    controller.close();
  } });
  const received = new Request("https://shop.test/webhooks/stripe", {
    method: "POST", headers: { "stripe-signature": `t=${timestamp},v1=${signature}` },
    body, duplex: "half",
  });
  const response = await fulfillStripeCheckoutWebhook(received, f.env);
  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { error: "invalid-json" },
    "signature accepts the original signed bytes; JSON separately refuses BOM text");
  assert.equal(await f.fulfillment.getEntitlement(checkout.sessionId), null,
    "invalid JSON cannot admit a paid entitlement");
});

test("malformed UTF-8 is not silently normalized into a valid signed Stripe event", async () => {
  const f = await fixture();
  const body = new ReadableStream({ start(controller) {
    controller.enqueue(new Uint8Array([0xc3]));
    controller.close();
  } });
  const request = new Request("https://shop.test/webhooks/stripe", { method: "POST",
    body, duplex: "half" });
  const response = await fulfillStripeCheckoutWebhook(request, f.env);
  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { error: "invalid-json" });
  assert.equal(await f.fulfillment.getEntitlement(checkout.sessionId), null);
});



const externalLinkId='plink_1USMywJ1vYnPQu2NWHtcqx0b';
const externalCheckout=(overrides={})=>({
 id:'evt_external_support_1',type:'checkout.session.completed',livemode:true,
 created:1792670000,data:{object:{
  id:'cs_external_support_1',payment_link:externalLinkId,
  status:'complete',payment_status:'paid',amount_total:1000,currency:'usd',
  payment_intent:'pi_external_support_1',
  customer_details:{email:'buyer-private@example.invalid'},
  metadata:{private_note:'never-persist'},
  ...overrides
 }}
});
function externalEnvironment(f){
 return {...f.env,externalPaymentLinks:[externalLinkId],audit:f.fulfillment.audit};
}

test('signed outside-catalog Stripe Payment Link is observed durably without any book entitlement or Group cash claim',async()=>{
 const f=await fixture(),env=externalEnvironment(f),event=externalCheckout();
 const received=await fulfillStripeCheckoutWebhook(request(event),env);
 assert.equal(received.status,200);
 assert.deepEqual(await received.json(),{
  accepted:true,externalCheckoutObserved:true,duplicate:false,settlement:'not-established'
 });
 const rows=[...f.rows.entries()];
 const audited=rows.find(([name])=>name==='audit:urn:stripe-event-receipt:evt_external_support_1')?.[1];
 assert.equal(audited?.record?.type,'StripeExternalPaymentLinkObservation');
 assert.equal(audited.record.schemaVersion,1);
 assert.equal(audited.record.stripePaymentLinkId,externalLinkId);
 assert.equal(audited.record.stripeCheckoutSessionId,'cs_external_support_1');
 assert.equal(audited.record.amountTotal,1000);
 assert.equal(audited.record.currency,'usd');
 assert.equal(audited.record.livemode,true);
 assert.equal(audited.record.signatureVerified,true);
 assert.equal(audited.record.buyerPersonalDataRecorded,false);
 assert.equal(audited.record.consequence,'outside-catalog-checkout-observed-not-group-treasury-settlement');
 assert.equal(JSON.stringify(audited).includes('buyer-private@example.invalid'),false);
 assert.equal(JSON.stringify(audited).includes('private_note'),false);
 assert.equal(JSON.stringify(audited).includes('pi_external_support_1'),false);
 assert.equal(f.rows.has('event:evt_external_support_1'),false);
 assert.equal(f.rows.has('checkout:cs_external_support_1'),false);
 assert.equal(f.rows.has('entitlement:cs_external_support_1'),false);
 assert.equal(await f.fulfillment.getEntitlement('cs_external_support_1'),null);
});

test('repeated exact signed external checkout keeps original immutable receipt and reports idempotence',async()=>{
 const f=await fixture(),env=externalEnvironment(f),event=externalCheckout();
 const first=await fulfillStripeCheckoutWebhook(request(event),env);
 assert.equal(first.status,200);
 const key='audit:urn:stripe-event-receipt:evt_external_support_1';
 const original=structuredClone(f.rows.get(key));
 const next=await fulfillStripeCheckoutWebhook(request(event),env);
 assert.deepEqual(await next.json(),{
  accepted:true,externalCheckoutObserved:true,duplicate:true,settlement:'not-established'
 });
 assert.deepEqual(f.rows.get(key),original);
 assert.equal([...f.rows.keys()].filter(x=>x===key).length,1);
 const contradictory=externalCheckout({amount_total:500});
 const mismatch=await fulfillStripeCheckoutWebhook(request(contradictory),env);
 assert.equal(mismatch.status,503,'conflicting provider data may not overwrite the first authenticated event');
 assert.deepEqual(f.rows.get(key),original);
});

test('external Stripe link observation is opt-in and invalid source/payment data never claims a customer',async()=>{
 const f=await fixture(),event=externalCheckout();
 const cases=[
  [event,{...f.env,audit:f.fulfillment.audit},409],
  [event,{...f.env,externalPaymentLinks:['not-a-link'],audit:f.fulfillment.audit},503],
  [event,{...f.env,externalPaymentLinks:[externalLinkId]},503],
  [externalCheckout({payment_link:'plink_DIFFERENT'}),externalEnvironment(f),409],
  [externalCheckout({payment_link:externalLinkId,amount_total:-1}),externalEnvironment(f),409],
  [externalCheckout({payment_link:externalLinkId,currency:'bad-usd'}),externalEnvironment(f),409],
  [externalCheckout({payment_link:externalLinkId,status:'open'}),externalEnvironment(f),409],
  [externalCheckout({payment_link:externalLinkId,payment_status:'unrecognized'}),externalEnvironment(f),409]
 ];
 for(const [source,env,status] of cases){
  const received=await fulfillStripeCheckoutWebhook(request(source),env);
  assert.equal(received.status,status,JSON.stringify(source.data.object));
 }
 const forged=await fulfillStripeCheckoutWebhook(request(event,'wrong-secret'),externalEnvironment(f));
 assert.equal(forged.status,400);
 assert.equal(f.rows.has('audit:urn:stripe-event-receipt:evt_external_support_1'),false);
 assert.equal(f.rows.has('entitlement:cs_external_support_1'),false);
});

test('external checkout storage refusal requests Stripe retry, not a pretend payment or delivered book',async()=>{
 const f=await fixture(),env=externalEnvironment(f);
 const failing={...env,audit:{record:async()=>{throw Error('persistent receiver unavailable')}}};
 const attempted=await fulfillStripeCheckoutWebhook(request(externalCheckout()),failing);
 assert.equal(attempted.status,503);
 assert.equal(f.rows.has('audit:urn:stripe-event-receipt:evt_external_support_1'),false);
 assert.equal(await f.fulfillment.getEntitlement('cs_external_support_1'),null);
});

/** Regression against successful Stripe ACK without an actual audit admission
 * response. These are isolated audit-adapter negative controls; the earlier
 * real Durable Object tests separately establish persistence and idempotence. */
const invalidExternalAuditAcks = [
 ['undefined',()=>undefined],
 ['null',()=>null],
 ['false scalar',()=>false],
 ['true scalar',()=>true],
 ['zero scalar',()=>0],
 ['one scalar',()=>1],
 ['empty string',()=>'' ],
 ['arbitrary string',()=> 'ok'],
 ['empty array',()=>[]],
 ['singleton array',()=>[1]],
 ['empty object',()=>({})],
 ['disposition false without receipt',()=>({duplicate:false})],
 ['disposition true without receipt',()=>({duplicate:true})],
 ['null disposition without receipt',()=>({duplicate:null})],
 ['string false disposition without receipt',()=>({duplicate:'false'})],
 ['zero disposition without receipt',()=>({duplicate:0})],
 ['one disposition without receipt',()=>({duplicate:1})],
 ['array disposition without receipt',()=>({duplicate:[]})],
 ['object disposition without receipt',()=>({duplicate:{}})],
 ['undefined disposition with receipt',entry=>({...entry,duplicate:undefined})],
 ['string true disposition with receipt',entry=>({...entry,duplicate:'true'})],
 ['numeric zero disposition with receipt',entry=>({...entry,duplicate:0})],
 ['null disposition with receipt',entry=>({...entry,duplicate:null})],
 ['altered amount',entry=>({...entry,duplicate:false,record:{...entry.record,amountTotal:0}})],
 ['altered receipt identity',entry=>({...entry,duplicate:false,record:{...entry.record,id:'urn:stripe-event-receipt:evt_other'}})],
 ['altered audit category',entry=>({...entry,duplicate:false,category:'unrelated'})],
 ['contradictory truth',entry=>({...entry,duplicate:false,told:{for:false,against:true}})],
 ['null record',entry=>({...entry,duplicate:false,record:null})],
 ['extra private field',entry=>({...entry,duplicate:false,record:{...entry.record,privateNote:'private'}})],
 ['altered provider event identity',entry=>({...entry,duplicate:false,record:{...entry.record,stripeEventId:'evt_other'}})]
];
for(const [name,reply] of invalidExternalAuditAcks)
 test('external signed event refuses an unconfirmed audit ACK: '+name,async()=>{
  const f=await fixture();
  const env={...externalEnvironment(f),audit:{record:async entry=>reply(entry)}};
  const response=await fulfillStripeCheckoutWebhook(request(externalCheckout()),env);
  assert.equal(response.status,503);
  assert.deepEqual(await response.json(),{error:'external-checkout-audit-unavailable'});
  assert.equal(f.rows.has('audit:urn:stripe-event-receipt:evt_external_support_1'),false);
  assert.equal(await f.fulfillment.getEntitlement('cs_external_support_1'),null);
 });
for(const duplicate of [false,true])
 test('external signed event interprets matching mock audit ACK: '+duplicate,async()=>{
  const f=await fixture();
  const env={...externalEnvironment(f),
   audit:{record:async entry=>({...entry,duplicate})}};
  const response=await fulfillStripeCheckoutWebhook(request(externalCheckout()),env);
  assert.equal(response.status,200);
  assert.deepEqual(await response.json(),{
   accepted:true,externalCheckoutObserved:true,duplicate,settlement:'not-established'
  });
  // A matching mock ACK exercises response compatibility, not actual storage.
  assert.equal(f.rows.has('audit:urn:stripe-event-receipt:evt_external_support_1'),false);
  assert.equal(await f.fulfillment.getEntitlement('cs_external_support_1'),null);
 });

/** Held-out negative controls: an audit adapter can mutate the receipt object
 * passed into it. The acceptance oracle must precede that mutable boundary. */
const mutatingExternalAuditAcks=[
 ['amount',entry=>{entry.record.amountTotal=0;}],
 ['receipt id',entry=>{entry.record.id='urn:stripe-event-receipt:evt_other';}],
 ['payment link',entry=>{entry.record.stripePaymentLinkId='plink_other';}],
 ['currency',entry=>{entry.record.currency='eur';}],
 ['checkout id',entry=>{entry.record.stripeCheckoutSessionId='cs_other';}],
 ['payment status',entry=>{entry.record.paymentStatus='unpaid';}],
 ['live/test mode',entry=>{entry.record.livemode=false;}],
 ['PII flag',entry=>{entry.record.buyerPersonalDataRecorded=true;}],
 ['truth statement',entry=>{entry.told.against=true;}],
 ['receipt category',entry=>{entry.category='unrelated';}]
];
for(const [name,mutate]of mutatingExternalAuditAcks)
 test('external audit ACK cannot conceal adapter mutation: '+name,async()=>{
  const f=await fixture();
  const env={...externalEnvironment(f),audit:{
   record:async entry=>{mutate(entry);return {...entry,duplicate:false};}
  }};
  const response=await fulfillStripeCheckoutWebhook(request(externalCheckout()),env);
  assert.equal(response.status,503);
  assert.deepEqual(await response.json(),{error:'external-checkout-audit-unavailable'});
  assert.equal(f.rows.has('audit:urn:stripe-event-receipt:evt_external_support_1'),false);
  assert.equal(await f.fulfillment.getEntitlement('cs_external_support_1'),null);
 });



/** Cross-owner receiving regression: the signed Stripe handler must see the
 * original durable client's fail-closed ACK semantics, not merely a fabricated
 * application-level mock adapter. These are offline synthetic DO responses. */
for(const [name,ack] of [
 ["duplicate absent",{ok:true}],
 ["duplicate encoded as string",{ok:true,duplicate:"false"}],
 ["duplicate encoded as number",{ok:true,duplicate:0}]
]) test("source-owned durable client must refuse a malformed successful HTTP admission reply: "+name,async()=>{
  const f=await fixture();
  let posted=0;
  const client=createDurableFulfillment({
    idFromName(){return "audit-fixture";},
    get(){return {async fetch(url,init){
      posted++;
      assert.equal(new URL(url).pathname,"/audit");
      const entry=JSON.parse(init.body);
      assert.equal(entry.record.stripeEventId,"evt_external_support_1");
      assert.equal(entry.record.stripePaymentLinkId,externalLinkId);
      assert.equal(JSON.stringify(entry).includes("buyer-private@example.invalid"),false);
      return Response.json(ack);
    }};}
  },"audit-fixture");
  const response=await fulfillStripeCheckoutWebhook(request(externalCheckout()),
    {...externalEnvironment(f),audit:client.audit});
  assert.equal(response.status,503);
  assert.deepEqual(await response.json(),{error:"external-checkout-audit-unavailable"});
  assert.equal(posted,1);
  assert.equal(await f.fulfillment.getEntitlement("cs_external_support_1"),null);
});
for(const duplicate of [false,true])
 test("signed external support event accepts an explicit durable Boolean reply: "+duplicate,async()=>{
  const f=await fixture();
  let posted=0;
  const client=createDurableFulfillment({
    idFromName(){return "audit-fixture";},
    get(){return {async fetch(url,init){
      posted++;
      assert.equal(new URL(url).pathname,"/audit");
      assert.equal(JSON.parse(init.body).record.stripeEventId,"evt_external_support_1");
      return Response.json({ok:true,duplicate});
    }};}
  },"audit-fixture");
  const response=await fulfillStripeCheckoutWebhook(request(externalCheckout()),
    {...externalEnvironment(f),audit:client.audit});
  assert.equal(response.status,200);
  assert.deepEqual(await response.json(),{
    accepted:true,externalCheckoutObserved:true,duplicate,settlement:"not-established"
  });
  assert.equal(posted,1);
  assert.equal(await f.fulfillment.getEntitlement("cs_external_support_1"),null);
 });


/** The raw event signature is recomputed for every adverse provider
 * observation. A valid signature does not permit one retained Stripe event ID
 * to change monetary facts or Checkout identity on a replay.
 */
const signedEventReinterpretations = [
  ["changed amount", { amount_total: 1201 }],
  ["changed currency", { currency: "eur" }],
  ["changed payment intent", { payment_intent: "pi_other" }],
  ["changed payment status", { payment_status: "unpaid" }],
  ["changed Checkout status", { status: "open" }],
  ["changed offering", { metadata: { offering_id: "other-book", request_digest: checkout.requestDigest } }],
  ["changed request digest", { metadata: { offering_id: checkout.offeringId, request_digest: "other-digest" } }],
];
for (const [label, changed] of signedEventReinterpretations)
  test("freshly signed replay refuses same event ID with " + label, async () => {
    const f = await fixture();
    const first = await fulfillStripeCheckoutWebhook(request(event()), f.env);
    assert.equal(first.status, 200);
    const savedEvent = structuredClone(f.rows.get("event:evt_async"));
    const savedPurchase = structuredClone(await f.fulfillment.getEntitlement(checkout.sessionId));
    const duplicate = await fulfillStripeCheckoutWebhook(request(event(undefined, changed)), f.env);
    assert.equal(duplicate.status, 409);
    assert.deepEqual(await duplicate.json(), { error: "payment-does-not-match-checkout-intent" });
    assert.deepEqual(f.rows.get("event:evt_async"), savedEvent);
    assert.deepEqual(await f.fulfillment.getEntitlement(checkout.sessionId), savedPurchase);
    const goodReplay = await fulfillStripeCheckoutWebhook(request(event()), f.env);
    assert.deepEqual(await goodReplay.json(), { accepted: true, duplicate: true });
  });
test("a signed replay with only its original Stripe event creation time remains idempotent", async () => {
  const f = await fixture();
  const actual = { ...event(), created: 1700000000 };
  assert.equal((await fulfillStripeCheckoutWebhook(request(actual), f.env)).status, 200);
  assert.deepEqual(await (await fulfillStripeCheckoutWebhook(request(actual), f.env)).json(), { accepted: true, duplicate: true });
  const changed = { ...actual, created: 1700000001 };
  const refused = await fulfillStripeCheckoutWebhook(request(changed), f.env);
  assert.equal(refused.status, 409);
  assert.deepEqual(await refused.json(), { error: "payment-does-not-match-checkout-intent" });
});


/** Signed, separately identified Stripe events must not replace a
 * Checkout's previously received payment intent. These exercise the original
 * HMAC request, provider projector, Worker receiver, Durable Object and
 * retained entitlement together; no substitute payment rail or fake event id.
 */
for (const [label, firstType, nextType, revoke, nextIntent] of [
  ["delayed success then completed with a second intent",
    "checkout.session.async_payment_succeeded", "checkout.session.completed", false, "pi_other"],
  ["completed then delayed success with a second intent",
    "checkout.session.completed", "checkout.session.async_payment_succeeded", false, "pi_different"],
  ["revoked purchase then changed payment intent",
    "checkout.session.async_payment_succeeded", "checkout.session.completed", true, "pi_other_after_refund"],
  ["delayed success then null payment intent",
    "checkout.session.async_payment_succeeded", "checkout.session.completed", false, null],
]) test("signed distinct event identity must refuse " + label, async () => {
  const f = await fixture();
  const initial = await fulfillStripeCheckoutWebhook(request(event(firstType)), f.env);
  assert.equal(initial.status, 200);
  if (revoke) {
    const withdrawn = await f.fulfillment.revokeEntitlement({
      sessionId: checkout.sessionId, paymentIntentId: "pi_fixture", reason: "refund",
    });
    assert.equal(withdrawn.disposition, "revoked");
  }
  const beforeEntitlement = structuredClone(await f.fulfillment.getEntitlement(checkout.sessionId));
  const beforeKeys = [...f.rows.keys()];
  const conflicting = {
    ...event(nextType, { payment_intent: nextIntent }),
    id: "evt_second_payment_intent",
  };
  const result = await fulfillStripeCheckoutWebhook(request(conflicting), f.env);
  assert.equal(result.status, 409);
  assert.deepEqual(await result.json(), { error: "payment-does-not-match-checkout-intent" });
  assert.deepEqual(await f.fulfillment.getEntitlement(checkout.sessionId), beforeEntitlement);
  assert.deepEqual([...f.rows.keys()], beforeKeys);
  assert.equal(f.rows.has("event:evt_second_payment_intent"), false);
  const originalRetry = await fulfillStripeCheckoutWebhook(request(event(firstType)), f.env);
  assert.deepEqual(await originalRetry.json(), { accepted: true, duplicate: true });
});

test("signed different event ID with original settled intent remains idempotent", async () => {
  const f = await fixture();
  assert.equal((await fulfillStripeCheckoutWebhook(request(event()), f.env)).status, 200);
  const original = structuredClone(await f.fulfillment.getEntitlement(checkout.sessionId));
  const second = { ...event("checkout.session.completed"), id: "evt_second_same_payment_intent" };
  const accepted = await fulfillStripeCheckoutWebhook(request(second), f.env);
  assert.equal(accepted.status, 200);
  assert.deepEqual(await accepted.json(), { accepted: true, duplicate: true });
  assert.equal(f.rows.get("event:evt_second_same_payment_intent")?.claimFacts?.paymentIntentId, "pi_fixture");
  assert.deepEqual(await f.fulfillment.getEntitlement(checkout.sessionId), original);
});
