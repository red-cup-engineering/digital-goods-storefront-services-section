import { CHECKOUT_EVENTS } from "@red-cup-engineering/stripe-services-section/checkout-events";
import { projectEvent, verifyStripeSignature } from "@red-cup-engineering/stripe-services-section";

export const SUPPORTS_EXTERNAL_STRIPE_PAYMENT_LINK_AUDIT=true;
const MAX_STRIPE_WEBHOOK_BYTES = 1024 * 1024;

const EXTERNAL_LINK=/^plink_[A-Za-z0-9]+$/u;
const PROVIDER_EVENT=/^evt_[A-Za-z0-9_]+$/u;
const PROVIDER_CHECKOUT=/^cs_[A-Za-z0-9_]+$/u;
/** Only the original storefront operator may select an outside-catalog
 * Payment Link. Stripe's valid HMAC authenticates the event, NOT the
 * competence of its publisher nor a Group treasury entitlement. */
function admittedExternalLinks(input){
 if(input===undefined)return new Set();
 if(!Array.isArray(input)||input.length>64||
    input.some(x=>typeof x!=='string'||!EXTERNAL_LINK.test(x))||
    new Set(input).size!==input.length)
  throw new TypeError('Source-qualified external Payment Link IDs are required');
 return new Set(input);
}
async function receiveExternalCheckout(event,projection,env){
 const amount=projection.amountTotal;
 if(!PROVIDER_EVENT.test(projection.stripeEventId??'')||
   !PROVIDER_CHECKOUT.test(projection.stripeObjectId??'')||
   typeof projection.livemode!=='boolean'||
   !['paid','unpaid','no_payment_required'].includes(projection.paymentStatus)||
   projection.status!=='complete'||
   !Number.isSafeInteger(amount)||amount<0||
   typeof projection.currency!=='string'||!/^[a-z]{3}$/u.test(projection.currency))
  return json({error:'external-checkout-original-event-incomplete'},409);
 if(!env.audit||typeof env.audit.record!=='function')
  return json({error:'external-checkout-audit-unavailable'},503);
 // No recipient account, customer email/name, or raw provider body crosses
 // this original read-only economic event boundary. Nor does it touch the
 // book entitlement/checkout registries.
 const record={
  id:'urn:stripe-event-receipt:'+projection.stripeEventId,
  type:'StripeExternalPaymentLinkObservation',schemaVersion:1,
  stripeEventId:projection.stripeEventId,eventType:projection.eventType,
  stripePaymentLinkId:event.data.object.payment_link,
  stripeCheckoutSessionId:projection.stripeObjectId,
  amountTotal:amount,currency:projection.currency,
  paymentStatus:projection.paymentStatus,status:projection.status,
  livemode:projection.livemode,
  stripeEventCreatedAt:Number.isSafeInteger(event.created)&&event.created>=0?event.created:null,
  signatureVerified:true,buyerPersonalDataRecorded:false,rawBodyRecorded:false,
  consequence:'outside-catalog-checkout-observed-not-group-treasury-settlement'
 };
 const receipt={
  category:'stripe-webhook-event-admission.events',
  recordedAt:new Date().toISOString(),
  record,told:{for:true,against:false}
 };
 // Snapshot our intent BEFORE calling an adapter that can mutate its input.
 // Comparing an ACK against that same mutable input is a circular oracle.
 const expectedCategory=receipt.category;
 const expectedRecord=JSON.stringify(receipt.record);
 const expectedTold=JSON.stringify(receipt.told);
 let persisted;
 try{
  persisted=await env.audit.record(receipt);
  // A fulfilled Promise is not a durable receipt. A custom/legacy adapter
  // can resolve undefined or an unrelated object without writing the event.
  // Keep Stripe retries possible unless the original audit client returns
  // its complete, matching admission envelope and explicit disposition.
  if(!persisted||typeof persisted!=='object'||
    (persisted.duplicate!==true&&persisted.duplicate!==false)||
    receipt.category!==expectedCategory||
    JSON.stringify(receipt.record)!==expectedRecord||
    JSON.stringify(receipt.told)!==expectedTold||
    persisted.category!==expectedCategory||
    JSON.stringify(persisted.record)!==expectedRecord||
    JSON.stringify(persisted.told)!==expectedTold)
    throw new TypeError('external-checkout-audit-receipt-missing-or-mismatched');
 }catch{
  return json({error:'external-checkout-audit-unavailable'},503);
 }
 return json({accepted:true,externalCheckoutObserved:true,
  duplicate:persisted.duplicate,settlement:'not-established'});
}

function json(value, status = 200) { return Response.json(value, { status, headers: { "cache-control": "no-store" } }); }
function supportsStore(store) { return store && ["recordCheckout", "getCheckout", "claimPayment", "getEntitlement"].every((name) => typeof store[name] === "function"); }

/** The Stripe signature covers the exact UTF-8 body. Read it once with a
 * byte bound *while streaming*; request.text() reads arbitrarily large bodies
 * before any post-read limit can protect the fulfillment receiver. */
async function boundedStripeWebhookText(request) {
  const reader = request.body?.getReader();
  if (!reader) return { text: "" };
  // Preserve leading BOM bytes through signature validation; JSON admission is separate.
  const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
  let totalBytes = 0, text = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > MAX_STRIPE_WEBHOOK_BYTES) {
        await reader.cancel();
        return { error: "stripe-webhook-body-too-large", status: 413 };
      }
      text += decoder.decode(value, { stream: true });
    }
    return { text: text + decoder.decode() };
  } catch (cause) {
    try { await reader.cancel(); } catch { /* body already closed */ }
    return cause instanceof TypeError
      ? { error: "invalid-json", status: 400 }
      : { error: "stripe-webhook-body-unavailable", status: 503 };
  } finally { reader.releaseLock(); }
}

/** Fulfill either immediate or delayed paid Checkout completion through the same verified, idempotent store. */
export async function fulfillStripeCheckoutWebhook(request, env) {
    if (!supportsStore(env.fulfillment)) return json({ error: "fulfillment-store-unavailable" }, 503);
    const received = await boundedStripeWebhookText(request);
    if (received.error) return json({ error: received.error }, received.status);
    const rawBody = received.text;
    if (!verifyStripeSignature({ rawBody, signatureHeader: request.headers.get("stripe-signature") ?? "", secret: env.STRIPE_WEBHOOK_SECRET })) return json({ error: "invalid-or-stale-stripe-signature" }, 400);
    let event; try { event = JSON.parse(rawBody); } catch { return json({ error: "invalid-json" }, 400); }
    if (!CHECKOUT_EVENTS.includes(event?.type)) return json({ accepted: true });
    let external;
    try{external=admittedExternalLinks(env.externalPaymentLinks);}
    catch{return json({error:'external-checkout-source-config-invalid'},503);}
    const projection = projectEvent(event);
    const rawLink=event?.data?.object?.payment_link;
    if(typeof rawLink==='string'&&external.has(rawLink))
      return receiveExternalCheckout(event,projection,env);
    if (!projection.stripeEventId || !projection.stripeObjectId || typeof projection.livemode !== "boolean") return json({ error: "payment-does-not-match-checkout-intent" }, 409);
    const result = await env.fulfillment.claimPayment({ eventId: projection.stripeEventId, eventType: projection.eventType, sessionId: projection.stripeObjectId, offeringId: projection.offeringId, requestDigest: projection.requestDigest, amountTotal: projection.amountTotal, currency: projection.currency, paymentStatus: projection.paymentStatus, status: projection.status, stripeMode: projection.livemode ? "live" : "test", paymentIntentId: projection.paymentIntentId, createdAt: projection.created });
    const claimed = typeof result === "string" ? result : result?.disposition;
    if (claimed === "rejected") return json({ error: "payment-does-not-match-checkout-intent" }, 409);
    if (claimed === "pending") return json({ accepted: true, pending: true });
    if (!["claimed", "duplicate", "duplicate-session"].includes(claimed)) return json({ error: "fulfillment-store-unavailable" }, 503);
    return json({ accepted: true, duplicate: claimed === "duplicate" || claimed === "duplicate-session" });
  }

