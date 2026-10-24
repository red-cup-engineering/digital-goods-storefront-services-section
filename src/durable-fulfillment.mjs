import { CHECKOUT_EVENTS } from "@red-cup-engineering/stripe-services-section/checkout-events";
import { reviewCopyEntitlement } from "./review-copy.mjs";

function reply(value, status = 200) { return Response.json(value ?? null, { status }); }
function sameCheckout(left, right) {
  return left && left.sessionId === right.sessionId && left.offeringId === right.offeringId && left.requestDigest === right.requestDigest && left.amountTotal === right.amountTotal && left.currency === right.currency && left.stripeMode === right.stripeMode && JSON.stringify(left.goods) === JSON.stringify(right.goods) && left.release === right.release && JSON.stringify(left.admittedRelease ?? null) === JSON.stringify(right.admittedRelease ?? null)
    // The same Checkout session cannot switch the bound buyer or status on a
    // retry. Absent and explicit null are equivalent for legacy consumers.
    && (left.account ?? null) === (right.account ?? null)
    && (left.status ?? null) === (right.status ?? null);
}
// Persist only the immutable, non-PII event facts consumed by Checkout
// receiving. A Stripe event ID cannot be reinterpreted as another amount,
// currency, payment intent or state during a retry.
function paymentClaimFacts(body, eventType) {
  return {
    sessionId: body.sessionId, type: eventType,
    offeringId: body.offeringId, requestDigest: body.requestDigest,
    amountTotal: body.amountTotal, currency: body.currency,
    stripeMode: body.stripeMode, paymentStatus: body.paymentStatus,
    status: body.status, paymentIntentId: body.paymentIntentId ?? null,
    createdAt: body.createdAt ?? null,
  };
}
function matchesPaymentCheckout(checkout, body) {
  return !!checkout && body.status === "complete"
    && checkout.offeringId === body.offeringId && checkout.requestDigest === body.requestDigest
    && checkout.amountTotal === body.amountTotal && checkout.currency === body.currency
    && checkout.stripeMode === body.stripeMode;
}
const EMAIL = /^[^\s@]+@[^\s@]+$/u;
const GIFT_ID = /^gift-[0-9a-f-]{36}$/u;
/** The one spelling of an account: its verified email, lowercased. */
export function accountOf(email) { return typeof email === "string" && EMAIL.test(email.trim()) ? email.trim().toLowerCase() : null; }

async function index(transaction, key, id) {
  const ids = (await transaction.get(key)) ?? [];
  if (!ids.includes(id)) await transaction.put(key, [...ids, id]);
}

/**
 * Cloudflare Durable Object persistence for a storefront receiver. It owns
 * immutable checkout records, payment-event admission, entitlements, and
 * Stripe receipt storage. An entitlement is either a purchase (keyed by its
 * Stripe Checkout Session id), a gift (keyed `gift-<uuid>`) or a review copy
 * (keyed `review-<uuid>`, see review-copy.mjs), and every
 * entitlement that names an account is listed under `account:<email>`, so a
 * reader's library is one read. A receiver supplies the binding and its
 * durable-object class alias; product policy remains in its catalog.
 */
export class DigitalGoodsFulfillment {
  constructor(ctx) { this.ctx = ctx; }
  async fetch(request) {
    const url = new URL(request.url);
    const body = request.method === "POST" ? await request.json() : null;
    if (request.method === "GET" && url.pathname.startsWith("/checkout/")) return reply(await this.ctx.storage.get(`checkout:${decodeURIComponent(url.pathname.slice(10))}`));
    if (request.method === "GET" && url.pathname.startsWith("/entitlement/")) return reply(await this.ctx.storage.get(`entitlement:${decodeURIComponent(url.pathname.slice(13))}`));
    if (request.method === "GET" && (url.pathname.startsWith("/account/") || url.pathname.startsWith("/grants/"))) {
      const [, kind, email] = url.pathname.split("/");
      const ids = (await this.ctx.storage.get(`${kind === "account" ? "account" : "grants"}:${accountOf(decodeURIComponent(email))}`)) ?? [];
      return reply((await Promise.all(ids.map((id) => this.ctx.storage.get(`entitlement:${id}`)))).filter(Boolean));
    }
    if (request.method === "POST" && url.pathname === "/checkout") return this.ctx.storage.transaction(async (transaction) => {
      const key = `checkout:${body.sessionId}`; const existing = await transaction.get(key);
      if (existing && !sameCheckout(existing, body)) return reply({ disposition: "conflict" }, 409);
      if (!existing) await transaction.put(key, body);
      return reply({ disposition: existing ? "duplicate" : "registered" });
    });
    if (request.method === "POST" && url.pathname === "/claim") return this.ctx.storage.transaction(async (transaction) => {
      const eventType = body.eventType ?? "checkout.session.completed";
      if (!CHECKOUT_EVENTS.includes(eventType)) return reply({ disposition: "rejected" }, 409);
      const claimFacts = paymentClaimFacts(body, eventType);
      const priorEvent = await transaction.get(`event:${body.eventId}`);
      if (priorEvent) {
        if (priorEvent.sessionId !== body.sessionId || priorEvent.type !== eventType)
          return reply({ disposition: "rejected" }, 409);
        if (priorEvent.claimFacts !== undefined) {
          // Complete receipts written by this revision are compared against
          // their ORIGINAL facts, not mutable Checkout or entitlement state.
          if (JSON.stringify(priorEvent.claimFacts) !== JSON.stringify(claimFacts))
            return reply({ disposition: "rejected" }, 409);
        } else {
          // Older persisted rows contain only session/type/pending. Do not
          // invent a full original payload: bound legacy retries to the
          // immutable Checkout and any already retained payment intent.
          // Legacy createdAt and other unknown facts remain unverified.
          const originalCheckout = await transaction.get(`checkout:${body.sessionId}`);
          if (!matchesPaymentCheckout(originalCheckout, body))
            return reply({ disposition: "rejected" }, 409);
          const pending = eventType === "checkout.session.completed" && body.paymentStatus === "unpaid";
          if ((priorEvent.pending === true) !== pending || (!pending && body.paymentStatus !== "paid"))
            return reply({ disposition: "rejected" }, 409);
          if (!pending) {
            const entitlement = await transaction.get(`entitlement:${body.sessionId}`);
            if (entitlement?.paymentIntentId != null && entitlement.paymentIntentId !== claimFacts.paymentIntentId)
              return reply({ disposition: "rejected" }, 409);
          }
        }
        return reply({ disposition: "duplicate" });
      }
      const checkout = await transaction.get(`checkout:${body.sessionId}`);
      const matched = matchesPaymentCheckout(checkout, body);
      if (!matched) return reply({ disposition: "rejected" }, 409);
      // Stripe may complete Checkout before an asynchronous method is paid.
      // Retain that original event without manufacturing an entitlement or
      // requiring Stripe to retry a legitimate, still-unpaid completion.
      if (eventType === "checkout.session.completed" && body.paymentStatus === "unpaid") {
        await transaction.put(`event:${body.eventId}`, { sessionId: body.sessionId, type: eventType, pending: true, claimFacts });
        return reply({ disposition: "pending" });
      }
      if (body.paymentStatus !== "paid") return reply({ disposition: "rejected" }, 409);
      const entitlementKey = `entitlement:${body.sessionId}`; const existing = await transaction.get(entitlementKey);
      // A second signed event for one Checkout is not another payment.
      // Compare the original settled payment intent BEFORE recording the new
      // event ID: an acknowledged mismatch would permanently suppress retries.
      if (existing && (existing.paymentIntentId ?? null) !== (body.paymentIntentId ?? null))
        return reply({ disposition: "rejected" }, 409);
      await transaction.put(`event:${body.eventId}`, { sessionId: body.sessionId, type: eventType, claimFacts });
      if (existing) return reply({ disposition: "duplicate-session" });
      const account = accountOf(checkout.account);
      await transaction.put(entitlementKey, { id: body.sessionId, kind: "purchase", sessionId: body.sessionId, offeringId: checkout.offeringId, goods: checkout.goods, release: checkout.release ?? null, admittedRelease: checkout.admittedRelease ?? null, account, status: "active", paymentIntentId: body.paymentIntentId ?? null, createdAt: body.createdAt ?? null });
      if (account) await index(transaction, `account:${account}`, body.sessionId);
      return reply({ disposition: "claimed" });
    });
    if (request.method === "POST" && url.pathname === "/grant") return this.ctx.storage.transaction(async (transaction) => {
      const recipient = accountOf(body?.recipientEmail); const gifter = accountOf(body?.grantedBy);
      // A review copy is a grant of its own stamped rendition with an expiry; a gift is the offering's release.
      const record = body?.kind === "review-copy" ? reviewCopyEntitlement(body, accountOf)
        : GIFT_ID.test(body?.id ?? "") && recipient && gifter && typeof body.offeringId === "string" && typeof body.release === "string"
          ? { id: body.id, kind: "gift", offeringId: body.offeringId, release: body.release, account: recipient, recipientEmail: recipient, grantedBy: gifter, note: typeof body.note === "string" ? body.note.slice(0, 1000) : "", status: "active", createdAt: body.createdAt ?? null }
          : null;
      if (!record) return reply({ disposition: "rejected" }, 400);
      const key = `entitlement:${record.id}`;
      if (await transaction.get(key)) return reply({ disposition: "duplicate" });
      await transaction.put(key, record);
      await index(transaction, `account:${record.account}`, record.id);
      await index(transaction, `grants:${record.grantedBy}`, record.id);
      return reply({ disposition: "granted" });
    });
    if (request.method === "POST" && url.pathname === "/bind") return this.ctx.storage.transaction(async (transaction) => {
      const account = accountOf(body?.account); const key = `entitlement:${body?.id}`; const existing = await transaction.get(key);
      if (!account || !existing || existing.status !== "active") return reply({ disposition: "unknown" }, 404);
      if (existing.account && existing.account !== account) return reply({ disposition: "held-by-another-account" }, 409);
      if (!existing.account) await transaction.put(key, { ...existing, account });
      await index(transaction, `account:${account}`, existing.id ?? body.id);
      return reply({ disposition: existing.account ? "duplicate" : "bound" });
    });
    if (request.method === "POST" && url.pathname === "/revoke") return this.ctx.storage.transaction(async (transaction) => {
      const id = body.id ?? body.sessionId; const existing = await transaction.get(`entitlement:${id}`);
      if (!existing || (body.paymentIntentId && existing.paymentIntentId !== body.paymentIntentId) || (body.grantedBy && existing.grantedBy !== accountOf(body.grantedBy))) return reply({ disposition: "unknown" }, 404);
      await transaction.put(`entitlement:${id}`, { ...existing, status: "revoked", revokedAt: body.revokedAt ?? null, revocationReason: body.reason ?? "withdrawn" });
      return reply({ disposition: "revoked" });
    });
    if (request.method === "POST" && url.pathname === "/audit") return this.ctx.storage.transaction(async (transaction) => {
      const id = body?.record?.id;
      if (typeof id !== "string" || !id) return reply({ error: "receipt-id-required" }, 400);
      const key=`audit:${id}`,existing=await transaction.get(key);
      if(existing){
        // An original signed event keeps one economic observation. Retries
        // may change local recording time, but never rewrite its provider
        // facts, category, or attributed truth.
        if(existing.category!==body.category||
          JSON.stringify(existing.record)!==JSON.stringify(body.record)||
          JSON.stringify(existing.told??null)!==JSON.stringify(body.told??null))
          return reply({error:'receipt-identity-conflict'},409);
        return reply({ok:true,duplicate:true});
      }
      await transaction.put(key,body);
      return reply({ok:true,duplicate:false});
    });
    return reply({ error: "not-found" }, 404);
  }
}

/** Creates the asynchronous client used by a Worker bound to one DO name. */
export function createDurableFulfillment(namespace, name) {
  if (!namespace || !name) return null;
  const stub = namespace.get(namespace.idFromName(name));
  const call = async (path, value) => {
    try {
      const response = await stub.fetch(`https://fulfillment${path}`, { method: "POST", body: JSON.stringify(value) });
      const body = await response.json();
      if (!body || typeof body !== "object") return { failed: true };
      if (!response.ok) return { ...body, failed: true };
      return body;
    } catch { return { failed: true }; }
  };
  const get = async (kind, id) => (await stub.fetch(`https://fulfillment/${kind}/${encodeURIComponent(id)}`)).json();
  return {
    async recordCheckout(value) { return call("/checkout", value); },
    async getCheckout(id) { return get("checkout", id); },
    async claimPayment(value) { return call("/claim", value); },
    async getEntitlement(id) { return get("entitlement", id); },
    async revokeEntitlement(value) { return call("/revoke", value); },
    async grantEntitlement(value) { return call("/grant", value); },
    async bindEntitlement(value) { return call("/bind", value); },
    async listAccount(email) { return (await get("account", email)) ?? []; },
    async listGrants(email) { return (await get("grants", email)) ?? []; },
    audit: { async record(entry) { const result = await call("/audit", entry); if (result.failed||result.ok!==true||typeof result.duplicate!=="boolean") throw new Error("could not record checkout receipt"); return {...entry,duplicate:result.duplicate}; } },
  };
}

