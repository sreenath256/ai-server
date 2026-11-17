import Stripe from "stripe";

const { STRIPE_SECRET_KEY, STRIPE_PUBLISHABLE_KEY, STRIPE_WEBHOOK_SECRET } = process.env;

export const stripeConfigured = Boolean(STRIPE_SECRET_KEY && STRIPE_PUBLISHABLE_KEY);
export const stripePublishableKey = STRIPE_PUBLISHABLE_KEY;
export const stripeWebhookSecret = STRIPE_WEBHOOK_SECRET;

if (!stripeConfigured) {
  console.warn(
    "[stripe] STRIPE_SECRET_KEY / STRIPE_PUBLISHABLE_KEY not set -- checkout will return 503 until configured."
  );
} else if (!STRIPE_WEBHOOK_SECRET) {
  console.warn(
    "[stripe] STRIPE_WEBHOOK_SECRET not set -- bookings will only be confirmed by the checkout page, not by Stripe's webhook."
  );
} else if (!/^whsec_[A-Za-z0-9]{16,}$/.test(STRIPE_WEBHOOK_SECRET)) {
  console.warn(
    "[stripe] STRIPE_WEBHOOK_SECRET does not look like a real signing secret (whsec_ followed by letters/digits) -- every webhook from Stripe will be rejected until it is fixed."
  );
}

export const stripe = stripeConfigured
  ? new Stripe(STRIPE_SECRET_KEY, { maxNetworkRetries: 2 })
  : null;

// Checkout must offer cards (and Apple/Google Pay) only. Bank debits, pay-by-bank and buy-now-pay-later
// settle over days or send the guest to another site, far outside the 30-minute date hold, and
// Stripe's newest API ignores `payment_method_types` -- the form shows whatever the account's default
// configuration enables. So we keep our own card-only configuration and attach it to every payment.
// It is looked up (or created) on first use, so test mode and live mode each get one automatically.
const CARD_ONLY_CONFIGURATION_NAME = "Chitown Lifestyles checkout (card only)";
let cardOnlyConfiguration = null;

export function getCardOnlyConfigurationId() {
  cardOnlyConfiguration ??= (async () => {
    const existing = await stripe.paymentMethodConfigurations.list({ limit: 100 });
    const found = existing.data.find((config) => config.active && config.name === CARD_ONLY_CONFIGURATION_NAME);
    if (found) return found.id;

    const on = { display_preference: { preference: "on" } };
    const created = await stripe.paymentMethodConfigurations.create({
      name: CARD_ONLY_CONFIGURATION_NAME,
      card: on,
      apple_pay: on,
      google_pay: on,
    });
    return created.id;
  })().catch((err) => {
    cardOnlyConfiguration = null;
    throw err;
  });
  return cardOnlyConfiguration;
}
