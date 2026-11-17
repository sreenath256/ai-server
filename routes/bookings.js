import { Router } from "express";
import { supabase, supabaseConfigured } from "../lib/supabase.js";
import { computeQuote } from "../lib/pricing.js";
import {
  getCardOnlyConfigurationId,
  stripe,
  stripeConfigured,
  stripePublishableKey,
} from "../lib/stripe.js";
import {
  cancelReservation,
  finalizeSucceededPayment,
  loadBooking,
} from "../lib/stripePayments.js";
import { getBookableProperty } from "../data/bookableProperties.js";

const router = Router();

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isUuid = (value) => typeof value === "string" && UUID_PATTERN.test(value);
const toCents = (amount) => Math.round(Number(amount) * 100);

function requireSupabase(req, res, next) {
  if (!supabaseConfigured) {
    return res.status(503).json({ error: "BOOKING_SYSTEM_UNAVAILABLE" });
  }
  next();
}
router.use(requireSupabase);

function requireStripe(req, res, next) {
  if (!stripeConfigured) {
    return res.status(503).json({ error: "PAYMENT_UNAVAILABLE" });
  }
  next();
}

async function sweepExpired() {
  const { error } = await supabase.rpc("release_expired_bookings");
  if (error) console.error("[bookings] Failed to sweep expired bookings:", error.message);
}

async function getBookedDates(propertyId) {
  const { data, error } = await supabase
    .from("booked_dates")
    .select("stay_date")
    .eq("property_id", propertyId)
    .order("stay_date", { ascending: true });
  if (error) throw error;
  return data.map((row) => row.stay_date);
}

function rangeOverlapsBooked(checkIn, checkOut, bookedDates) {
  const bookedSet = new Set(bookedDates);
  const cursor = new Date(`${checkIn}T00:00:00Z`);
  const end = new Date(`${checkOut}T00:00:00Z`);
  const conflicts = [];
  while (cursor < end) {
    const iso = cursor.toISOString().slice(0, 10);
    if (bookedSet.has(iso)) conflicts.push(iso);
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return conflicts;
}

function maskEmail(email) {
  const [user, domain] = String(email).split("@");
  if (!domain) return "";
  return `${user[0]}${"*".repeat(Math.max(user.length - 1, 2))}@${domain}`;
}

// A hold that has run out is reported as "expired" even before the sweep has flipped the row.
function effectiveStatus(booking) {
  if (booking.status === "pending_payment" && new Date(booking.expires_at) <= new Date()) {
    return "expired";
  }
  return booking.status;
}

// GET /api/bookings/:propertyId/booked-dates
router.get("/:propertyId/booked-dates", async (req, res) => {
  const property = getBookableProperty(req.params.propertyId);
  if (!property) return res.status(404).json({ error: "PROPERTY_NOT_FOUND" });

  await sweepExpired();
  const bookedDates = await getBookedDates(req.params.propertyId);
  res.json({ propertyId: req.params.propertyId, bookedDates });
});

// POST /api/bookings/quote
router.post("/quote", async (req, res) => {
  const { propertyId, checkIn, checkOut, guests } = req.body || {};
  const quote = computeQuote({ propertyId, checkIn, checkOut, guests });
  if (quote.error) return res.status(quote.error.status).json({ error: quote.error.code });

  await sweepExpired();
  const bookedDates = await getBookedDates(propertyId);
  const conflictingDates = rangeOverlapsBooked(checkIn, checkOut, bookedDates);
  if (conflictingDates.length > 0) {
    return res.status(409).json({ error: "SOME_DATES_UNAVAILABLE", conflictingDates });
  }

  res.json({
    propertyId,
    nights: quote.nights,
    pricePerNight: quote.pricePerNight,
    currency: quote.currency,
    totalAmount: quote.totalAmount,
    available: true,
  });
});

// POST /api/bookings/reserve
router.post("/reserve", async (req, res) => {
  const { propertyId, checkIn, checkOut, guests, guest } = req.body || {};
  if (!guest?.name || !guest?.email) {
    return res.status(422).json({ error: "MISSING_GUEST_DETAILS" });
  }

  const quote = computeQuote({ propertyId, checkIn, checkOut, guests });
  if (quote.error) return res.status(quote.error.status).json({ error: quote.error.code });

  await sweepExpired();

  const { data: bookingId, error } = await supabase.rpc("reserve_booking", {
    p_property_id: propertyId,
    p_check_in: checkIn,
    p_check_out: checkOut,
    p_guest_name: guest.name,
    p_guest_email: guest.email,
    p_guest_phone: guest.phone || null,
    p_guests_count: quote.guests,
    p_price_per_night: quote.pricePerNight,
    p_total_amount: quote.totalAmount,
    p_currency: quote.currency,
  });

  if (error) {
    if (error.code === "23505") {
      return res.status(409).json({ error: "DATES_JUST_TAKEN" });
    }
    console.error("[bookings] reserve_booking failed:", error.message);
    return res.status(500).json({ error: "RESERVE_FAILED" });
  }

  const booking = await loadBooking(bookingId);
  res.status(201).json({
    bookingId,
    propertyId,
    nights: quote.nights,
    totalAmount: quote.totalAmount,
    currency: quote.currency,
    status: "pending_payment",
    expiresAt: booking?.expires_at ?? new Date(Date.now() + 30 * 60 * 1000).toISOString(),
  });
});

// GET /api/bookings/order/:bookingId -- what the checkout page needs to render the order summary
router.get("/order/:bookingId", async (req, res) => {
  if (!isUuid(req.params.bookingId)) return res.status(404).json({ error: "BOOKING_NOT_FOUND" });
  const booking = await loadBooking(req.params.bookingId);
  if (!booking) return res.status(404).json({ error: "BOOKING_NOT_FOUND" });

  const property = getBookableProperty(booking.property_id);
  res.json({
    bookingId: booking.id,
    propertyId: booking.property_id,
    propertyTitle: property?.title ?? booking.property_id,
    checkIn: booking.check_in,
    checkOut: booking.check_out,
    nights: booking.nights,
    guests: booking.guests_count,
    pricePerNight: Number(booking.price_per_night),
    totalAmount: Number(booking.total_amount),
    currency: booking.currency,
    status: effectiveStatus(booking),
    expiresAt: booking.expires_at,
    guestFirstName: String(booking.guest_name).split(" ")[0],
    guestEmailMasked: maskEmail(booking.guest_email),
  });
});

// POST /api/bookings/order/:bookingId/cancel -- guest gives the held dates back
router.post("/order/:bookingId/cancel", async (req, res) => {
  if (!isUuid(req.params.bookingId)) return res.status(404).json({ error: "BOOKING_NOT_FOUND" });
  const result = await cancelReservation(req.params.bookingId);
  if (result.ok) return res.json({ status: "cancelled" });
  const status = result.code === "NOT_FOUND" ? 404 : 409;
  res.status(status).json({ error: result.code });
});

// POST /api/bookings/stripe/create-intent
// Idempotent: reloading the checkout page hands back the same open PaymentIntent
// instead of creating a second one.
router.post("/stripe/create-intent", requireStripe, async (req, res) => {
  const { bookingId } = req.body || {};
  if (!isUuid(bookingId)) return res.status(404).json({ error: "BOOKING_NOT_FOUND" });

  const booking = await loadBooking(bookingId);
  if (!booking) return res.status(404).json({ error: "BOOKING_NOT_FOUND" });
  if (booking.status === "confirmed") return res.status(409).json({ error: "ALREADY_PAID" });
  if (effectiveStatus(booking) !== "pending_payment") {
    return res.status(410).json({ error: "BOOKING_EXPIRED" });
  }

  try {
    const { data: attempts } = await supabase
      .from("payments")
      .select("provider_ref, created_at")
      .eq("booking_id", bookingId)
      .eq("provider", "stripe")
      .order("created_at", { ascending: false });

    const latest = attempts?.[0];
    if (latest?.provider_ref) {
      const existing = await stripe.paymentIntents.retrieve(latest.provider_ref);
      if (existing.status === "succeeded") {
        await finalizeSucceededPayment(existing);
        return res.status(409).json({ error: "ALREADY_PAID" });
      }
      if (existing.status === "processing") {
        return res.status(409).json({ error: "PAYMENT_PROCESSING", paymentIntentId: existing.id });
      }
      if (existing.status !== "canceled") {
        return res.json({
          clientSecret: existing.client_secret,
          publishableKey: stripePublishableKey,
          paymentIntentId: existing.id,
        });
      }
    }

    const property = getBookableProperty(booking.property_id);
    const paymentIntent = await stripe.paymentIntents.create(
      {
        amount: toCents(booking.total_amount),
        currency: booking.currency.toLowerCase(),
        payment_method_configuration: await getCardOnlyConfigurationId(),
        // Belt and braces: even if someone later adds a redirecting method to that configuration,
        // never send the guest away mid-payment (it would clash with the reload protection).
        automatic_payment_methods: { enabled: true, allow_redirects: "never" },
        receipt_email: booking.guest_email,
        description: `${property?.title ?? booking.property_id}: ${booking.check_in} to ${booking.check_out}`,
        metadata: {
          bookingId,
          propertyId: booking.property_id,
          checkIn: booking.check_in,
          checkOut: booking.check_out,
        },
      },
      { idempotencyKey: `booking-${bookingId}-intent-${attempts?.length ?? 0}` }
    );

    const { error: insertError } = await supabase.from("payments").upsert(
      {
        booking_id: bookingId,
        provider: "stripe",
        provider_ref: paymentIntent.id,
        status: "pending",
        amount: booking.total_amount,
        currency: booking.currency,
      },
      { onConflict: "provider,provider_ref", ignoreDuplicates: true }
    );
    if (insertError) {
      console.error("[bookings] Could not record the Stripe payment (is supabase/stripe_migration.sql applied?):", insertError.message);
      return res.status(500).json({ error: "PAYMENT_SETUP_FAILED" });
    }

    res.json({
      clientSecret: paymentIntent.client_secret,
      publishableKey: stripePublishableKey,
      paymentIntentId: paymentIntent.id,
    });
  } catch (err) {
    console.error("[bookings] create-intent failed:", err.message);
    res.status(502).json({ error: "PAYMENT_SETUP_FAILED" });
  }
});

// POST /api/bookings/stripe/confirm
// Called by the checkout page right after Stripe reports success (and while polling a
// slow payment). Asks Stripe directly -- never trusts the browser -- and finalizes.
router.post("/stripe/confirm", requireStripe, async (req, res) => {
  const { bookingId, paymentIntentId } = req.body || {};
  if (!isUuid(bookingId) || typeof paymentIntentId !== "string") {
    return res.status(404).json({ error: "BOOKING_NOT_FOUND" });
  }

  try {
    const paymentIntent = await stripe.paymentIntents.retrieve(paymentIntentId);
    if (paymentIntent.metadata?.bookingId !== bookingId) {
      return res.status(404).json({ error: "BOOKING_NOT_FOUND" });
    }

    if (paymentIntent.status === "succeeded") {
      const result = await finalizeSucceededPayment(paymentIntent);
      return res.json({ status: result.outcome === "refunded" ? "refunded" : "confirmed" });
    }
    if (paymentIntent.status === "processing") return res.json({ status: "processing" });
    res.status(402).json({ error: "PAYMENT_NOT_COMPLETED", status: paymentIntent.status });
  } catch (err) {
    console.error("[bookings] stripe confirm failed:", err.message);
    res.status(502).json({ error: "CONFIRM_FAILED" });
  }
});

export default router;
