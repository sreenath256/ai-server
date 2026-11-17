import { stripe, stripeWebhookSecret } from "../lib/stripe.js";
import { supabaseConfigured } from "../lib/supabase.js";
import { finalizeSucceededPayment, recordFailedPayment } from "../lib/stripePayments.js";

// Mounted in server.js BEFORE express.json(): signature verification needs the raw request body.
export async function stripeWebhookHandler(req, res) {
  if (!stripe || !stripeWebhookSecret || !supabaseConfigured) {
    return res.status(503).send("Stripe webhook is not configured");
  }

  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, req.headers["stripe-signature"], stripeWebhookSecret);
  } catch (err) {
    console.error("[stripe] Webhook signature verification failed:", err.message);
    return res.status(400).send("Invalid signature");
  }

  try {
    if (event.type === "payment_intent.succeeded") {
      await finalizeSucceededPayment(event.data.object);
    } else if (event.type === "payment_intent.payment_failed") {
      await recordFailedPayment(event.data.object);
    }
    res.json({ received: true });
  } catch (err) {
    // A non-2xx makes Stripe retry the delivery, which is what we want for a transient failure.
    console.error(`[stripe] Webhook handler failed for ${event.type}:`, err);
    res.status(500).send("Webhook handler failed");
  }
}
