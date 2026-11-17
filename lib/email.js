import nodemailer from "nodemailer";
import { getBookableProperty } from "../data/bookableProperties.js";

const {
  EMAIL_USER,
  EMAIL_APP_PASSWORD,
  ADMIN_EMAIL,
  RESEND_API_KEY,
  EMAIL_FROM,
  EMAIL_REPLY_TO,
} = process.env;

// Two ways to send, picked by what is in .env:
//  - RESEND_API_KEY + EMAIL_FROM: sends from your own verified domain through Resend's SMTP relay.
//  - otherwise EMAIL_USER + EMAIL_APP_PASSWORD: sends through a Gmail account.
const useResend = Boolean(RESEND_API_KEY && EMAIL_FROM);
const useGmail = Boolean(EMAIL_USER && EMAIL_APP_PASSWORD);
const emailConfigured = Boolean(ADMIN_EMAIL && (useResend || useGmail));
const fromAddress = useResend ? EMAIL_FROM : EMAIL_USER;

let transporter = null;
if (emailConfigured && useResend) {
  transporter = nodemailer.createTransport({
    host: "smtp.resend.com",
    port: 465,
    secure: true,
    auth: { user: "resend", pass: RESEND_API_KEY },
  });
} else if (emailConfigured) {
  transporter = nodemailer.createTransport({
    service: "gmail",
    auth: { user: EMAIL_USER, pass: EMAIL_APP_PASSWORD },
  });
} else {
  console.warn(
    "[email] Set ADMIN_EMAIL plus either RESEND_API_KEY + EMAIL_FROM, or EMAIL_USER + EMAIL_APP_PASSWORD -- booking emails will be skipped."
  );
}

function money(amount, currency) {
  return `${currency} ${Number(amount).toFixed(2)}`;
}

function formatDate(isoDate) {
  return new Date(`${isoDate}T00:00:00Z`).toLocaleDateString("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  });
}

function propertyName(booking) {
  return getBookableProperty(booking.property_id)?.title ?? booking.property_id;
}

function formatBooking(booking) {
  return [
    `Booking reference: ${booking.id.slice(0, 8).toUpperCase()}`,
    `Property: ${propertyName(booking)}`,
    `Check-in: ${formatDate(booking.check_in)}`,
    `Check-out: ${formatDate(booking.check_out)}`,
    `Guests: ${booking.guests_count}`,
    `Total: ${money(booking.total_amount, booking.currency)}`,
  ].join("\n");
}

const TEMPLATES = {
  confirmed: (booking) => ({
    guestSubject: `Booking confirmed: ${propertyName(booking)}`,
    guestBody: `Hi ${booking.guest_name},\n\nYour payment was received and your reservation is confirmed!\n\n${formatBooking(
      booking
    )}\n\nWe look forward to hosting you.\n\n-- Chitown Lifestyles`,
    adminSubject: `New confirmed booking: ${propertyName(booking)}`,
    adminBody: `A new booking was confirmed and paid.\n\n${formatBooking(
      booking
    )}\nGuest: ${booking.guest_name}\nGuest email: ${booking.guest_email}\nGuest phone: ${booking.guest_phone || "n/a"}`,
  }),
  payment_failed: (booking) => ({
    guestSubject: "Your payment could not be processed",
    guestBody: `Hi ${booking.guest_name},\n\nWe weren't able to process your payment, so you have not been charged. Your dates are still being held for you for a short while -- you can return to the checkout page and try again with another card.\n\n${formatBooking(
      booking
    )}\n\nIf you keep having trouble, just reply to this email and we'll help.\n\n-- Chitown Lifestyles`,
    adminSubject: `Payment attempt failed: ${propertyName(booking)}`,
    adminBody: `A card payment attempt failed. The dates are still held for the guest until their hold expires.\n\n${formatBooking(
      booking
    )}\nGuest: ${booking.guest_name}\nGuest email: ${booking.guest_email}\nGuest phone: ${booking.guest_phone || "n/a"}`,
  }),
  refunded: (booking) => ({
    guestSubject: "Your Chitown Lifestyles payment was refunded",
    guestBody: `Hi ${booking.guest_name},\n\nYour payment went through, but the hold on these dates had already ended, so we could not confirm the stay. You have been fully refunded -- it usually appears on your statement within 5-10 business days.\n\n${formatBooking(
      booking
    )}\n\nWe're sorry for the inconvenience -- please try booking again.\n\n-- Chitown Lifestyles`,
    adminSubject: `Payment auto-refunded (hold expired): ${propertyName(booking)}`,
    adminBody: `A payment succeeded after the guest's hold had ended, so it was automatically refunded in full.\n\n${formatBooking(
      booking
    )}\nGuest: ${booking.guest_name}\nGuest email: ${booking.guest_email}`,
  }),
};

/**
 * Sends the guest + admin email pair for a booking outcome.
 * Never throws -- a failed email must not fail an otherwise-successful/handled booking flow.
 */
export async function sendBookingEmail({ type, booking }) {
  const template = TEMPLATES[type];
  if (!template) {
    console.error(`[email] Unknown email type: ${type}`);
    return;
  }
  if (!transporter) {
    console.warn(`[email] Skipping "${type}" email (not configured) for booking ${booking.id}`);
    return;
  }

  const { guestSubject, guestBody, adminSubject, adminBody } = template(booking);

  try {
    await transporter.sendMail({
      from: fromAddress,
      replyTo: EMAIL_REPLY_TO || undefined,
      to: booking.guest_email,
      subject: guestSubject,
      text: guestBody,
    });
  } catch (err) {
    console.error(`[email] Failed to send guest email for booking ${booking.id}:`, err.message);
  }

  try {
    await transporter.sendMail({
      from: fromAddress,
      to: ADMIN_EMAIL,
      replyTo: booking.guest_email,
      subject: adminSubject,
      text: adminBody,
    });
  } catch (err) {
    console.error(`[email] Failed to send admin email for booking ${booking.id}:`, err.message);
  }
}
