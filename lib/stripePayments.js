import { supabase } from "./supabase.js";
import { stripe } from "./stripe.js";
import { sendBookingEmail } from "./email.js";

export async function loadBooking(bookingId) {
  const { data, error } = await supabase.from("bookings").select("*").eq("id", bookingId).maybeSingle();
  if (error) throw error;
  return data;
}

async function getPaymentStatus(paymentIntentId) {
  const { data } = await supabase
    .from("payments")
    .select("status")
    .eq("provider", "stripe")
    .eq("provider_ref", paymentIntentId)
    .maybeSingle();
  return data?.status ?? null;
}

async function savePayment(paymentIntent, booking, status, raw = null) {
  const { error } = await supabase.from("payments").upsert(
    {
      booking_id: booking.id,
      provider: "stripe",
      provider_ref: paymentIntent.id,
      status,
      amount: booking.total_amount,
      currency: booking.currency,
      raw_response: raw,
    },
    { onConflict: "provider,provider_ref" }
  );
  if (error) {
    console.error(`[stripe] Failed to record ${status} payment ${paymentIntent.id}:`, error.message);
  }
}

/**
 * Turns a successful Stripe payment into a confirmed booking. Safe to call any
 * number of times and from several places at once (webhook retries, the
 * checkout page, a reload): only the call that actually flips the booking
 * from pending_payment to confirmed sends the confirmation email.
 *
 * If the guest's hold had already lapsed (expired/cancelled) by the time the
 * money arrived, the payment is refunded in full instead.
 */
export async function finalizeSucceededPayment(paymentIntent) {
  const bookingId = paymentIntent.metadata?.bookingId;
  if (!bookingId) return { outcome: "unknown_booking" };

  const { data: confirmed, error } = await supabase
    .from("bookings")
    .update({ status: "confirmed", updated_at: new Date().toISOString() })
    .eq("id", bookingId)
    .eq("status", "pending_payment")
    .select()
    .maybeSingle();
  if (error) throw error;

  if (confirmed) {
    await savePayment(paymentIntent, confirmed, "succeeded", {
      amount_received: paymentIntent.amount_received,
      latest_charge: paymentIntent.latest_charge,
    });
    await sendBookingEmail({ type: "confirmed", booking: confirmed });
    return { outcome: "confirmed", booking: confirmed };
  }

  // Someone else may have confirmed it a moment ago (webhook + checkout page race), so
  // decide from a fresh read, never from anything loaded before the update above.
  const booking = await loadBooking(bookingId);
  if (!booking) return { outcome: "unknown_booking" };
  if (booking.status === "confirmed") return { outcome: "already_confirmed", booking };

  // The dates are no longer held for this guest: give the money back.
  if ((await getPaymentStatus(paymentIntent.id)) === "refunded") return { outcome: "refunded", booking };

  await stripe.refunds.create({ payment_intent: paymentIntent.id }, { idempotencyKey: `refund-${paymentIntent.id}` });
  await savePayment(paymentIntent, booking, "refunded", { reason: `booking_${booking.status}` });
  await sendBookingEmail({ type: "refunded", booking });
  return { outcome: "refunded", booking };
}

/**
 * Records a declined/failed attempt and emails guest + admin once. The
 * reservation stays held so the guest can retry with another card.
 */
export async function recordFailedPayment(paymentIntent) {
  const bookingId = paymentIntent.metadata?.bookingId;
  if (!bookingId) return { outcome: "unknown_booking" };

  const booking = await loadBooking(bookingId);
  if (!booking || booking.status !== "pending_payment") return { outcome: "ignored" };

  const previous = await getPaymentStatus(paymentIntent.id);
  if (previous && previous !== "pending") return { outcome: "duplicate" };

  const lastError = paymentIntent.last_payment_error;
  await savePayment(paymentIntent, booking, "failed", {
    code: lastError?.code ?? null,
    decline_code: lastError?.decline_code ?? null,
    message: lastError?.message ?? null,
  });
  await sendBookingEmail({ type: "payment_failed", booking });
  return { outcome: "failed" };
}

/**
 * Releases a guest's held dates on request. Refuses if a payment is already
 * succeeded/processing so a charged guest can never lose their dates.
 */
export async function cancelReservation(bookingId) {
  const booking = await loadBooking(bookingId);
  if (!booking) return { ok: false, code: "NOT_FOUND" };
  if (booking.status === "cancelled") return { ok: true };
  if (booking.status !== "pending_payment") return { ok: false, code: "NOT_CANCELLABLE" };

  const { data: payment } = await supabase
    .from("payments")
    .select("provider_ref")
    .eq("booking_id", bookingId)
    .eq("provider", "stripe")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (payment?.provider_ref && stripe) {
    try {
      const paymentIntent = await stripe.paymentIntents.retrieve(payment.provider_ref);
      if (paymentIntent.status === "succeeded" || paymentIntent.status === "processing") {
        return { ok: false, code: "PAYMENT_IN_PROGRESS" };
      }
      if (paymentIntent.status !== "canceled") {
        await stripe.paymentIntents.cancel(paymentIntent.id);
      }
    } catch (err) {
      console.error("[stripe] Could not cancel payment intent:", err.message);
      return { ok: false, code: "PAYMENT_IN_PROGRESS" };
    }
  }

  const { data: cancelled } = await supabase
    .from("bookings")
    .update({ status: "cancelled", updated_at: new Date().toISOString() })
    .eq("id", bookingId)
    .eq("status", "pending_payment")
    .select()
    .maybeSingle();
  if (!cancelled) return { ok: false, code: "NOT_CANCELLABLE" };

  await supabase.from("booked_dates").delete().eq("booking_id", bookingId);
  if (payment?.provider_ref) {
    await supabase
      .from("payments")
      .update({ status: "failed", raw_response: { canceled_by_guest: true } })
      .eq("provider", "stripe")
      .eq("provider_ref", payment.provider_ref)
      .eq("status", "pending");
  }
  return { ok: true };
}
