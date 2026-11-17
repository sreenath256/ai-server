// Server-side mirror of the bookable properties defined in the frontend at
// chitown-lifestyles/client/src/data/propertiesData.js. Only the fields needed
// to compute a trustworthy price live here -- the client can send anything it
// wants for a quote/reservation request, but the total charged always comes
// from this file, never from the request body.
//
// Keep this list in sync by hand whenever a property is added/removed or its
// price changes on the frontend -- the two repos don't share code.
export const BOOKABLE_PROPERTIES = [
  { id: "tropical-staycation", title: "Tropical Staycation", price: 450, priceUnit: "night" },
  { id: "chicago-luxury-house", title: "Sleeps 24+ Luxury House Near Chicago 12 King Beds", price: 850, priceUnit: "night" },
  { id: "estate-on-the-lake", title: "Estate on the Lake", price: 750, priceUnit: "night" },
  { id: "galeon-495-hts", title: "Galeon 495 HTS Luxury Yacht", price: 1250, priceUnit: "day" },
  { id: "wonder-real-lounge", title: "Wonder Real Lounge Luxury Motorhome", price: 350, priceUnit: "night" },
];

export function getBookableProperty(propertyId) {
  return BOOKABLE_PROPERTIES.find((p) => p.id === propertyId) || null;
}
