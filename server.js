import "dotenv/config";
import express from "express";
import cors from "cors";
import OpenAI from "openai";
import bookingsRouter from "./routes/bookings.js";
import { stripeWebhookHandler } from "./routes/stripeWebhook.js";

const app = express();

app.use(cors());

// Stripe signs the raw request body, so this must be registered before express.json().
app.post("/api/bookings/stripe/webhook", express.raw({ type: "application/json" }), stripeWebhookHandler);

app.use(express.json());

app.use("/api/bookings", bookingsRouter);

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// Test route
app.get("/", (req, res) => {
  res.send("AI Server is running...");
});

// Chat route
app.post("/chat", async (req, res) => {
  try {
    const { message } = req.body;

    const completion = await openai.chat.completions.create({
      model: "gpt-4.1-mini",
      messages: [
        {
          role: "system",
          content: `
You are the AI assistant for Chitown Lifestyles.

Only answer questions related to:
- Vacation Home Rentals
- Yacht Rentals
- Motorhome Rentals
- Company Information
- Booking
- Contact

If someone asks unrelated questions, politely tell them you're only here to help with Chitown Lifestyles.
          `,
        },
        {
          role: "user",
          content: message,
        },
      ],
    });

    res.json({
      reply: completion.choices[0].message.content,
    });
  } catch (error) {
    console.error(error);

    res.status(500).json({
      error: error.message,
    });
  }
});

app.listen(process.env.PORT, () => {
  console.log(`Server running on port ${process.env.PORT}`);
});