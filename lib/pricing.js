import { getBookableProperty } from "../data/bookableProperties.js";

const MS_PER_DAY = 24 * 60 * 60 * 1000;

function parseDate(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const date = new Date(`${value}T00:00:00Z`);
  return Number.isNaN(date.getTime()) ? null : date;
}

function todayUTC() {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

/**
 * Validates a booking request and computes its price server-side.
 * Never trust a price sent by the client -- this is the only source of truth.
 * Returns { error } on invalid input, otherwise { property, checkIn, checkOut, nights, pricePerNight, totalAmount, currency }.
 */
export function computeQuote({ propertyId, checkIn, checkOut, guests }) {
  const property = getBookableProperty(propertyId);
  if (!property) return { error: { status: 404, code: "PROPERTY_NOT_FOUND" } };

  const checkInDate = parseDate(checkIn);
  const checkOutDate = parseDate(checkOut);
  if (!checkInDate || !checkOutDate) {
    return { error: { status: 422, code: "INVALID_DATES", message: "checkIn/checkOut must be YYYY-MM-DD" } };
  }
  if (checkInDate < todayUTC()) {
    return { error: { status: 422, code: "CHECK_IN_IN_PAST" } };
  }
  if (checkOutDate <= checkInDate) {
    return { error: { status: 422, code: "CHECK_OUT_BEFORE_CHECK_IN" } };
  }

  const guestsCount = Number.isInteger(guests) && guests > 0 ? guests : 1;
  const nights = Math.round((checkOutDate - checkInDate) / MS_PER_DAY);
  const pricePerNight = property.price;
  const totalAmount = Math.round(pricePerNight * nights * 100) / 100;

  return {
    property,
    checkIn,
    checkOut,
    guests: guestsCount,
    nights,
    pricePerNight,
    totalAmount,
    currency: "USD",
  };
}
