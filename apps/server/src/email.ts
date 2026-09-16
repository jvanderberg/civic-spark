import nodemailer from "nodemailer";
import { z } from "zod";

export type LoginEmail = { email: string; url: string };
export type EmailDelivery = { configured: boolean; send: (message: LoginEmail) => Promise<void> };

// Provider boundary: identity and event code depend only on EmailDelivery.
// Never log messages: sign-in URLs are credentials.
export function createEmailDelivery(env: NodeJS.ProcessEnv = process.env): EmailDelivery {
  const provider = z
    .enum(["disabled", "resend", "smtp"])
    .parse(env.VIBEHACK_EMAIL_PROVIDER ?? "disabled");
  if (provider === "disabled")
    return {
      configured: false,
      async send() {
        throw new Error("Email delivery is not configured");
      },
    };
  const required = (key: string): string => {
    const value = env[key];
    if (!value?.trim()) throw new Error(`${key} is required for ${provider} email delivery`);
    return value;
  };
  const from = required("VIBEHACK_EMAIL_FROM");
  const message = ({ email, url }: LoginEmail) => ({
    from,
    to: [email],
    subject: "Your VibeHack sign-in link",
    text: `Sign in to VibeHack:\n\n${url}\n\nThis link verifies your email and signs you in. It expires in 10 minutes and can be used once.\n\nIf you did not request this email, you can ignore it.`,
  });
  if (provider === "smtp") {
    const port = z.coerce
      .number()
      .int()
      .min(1)
      .max(65535)
      .parse(env.SMTP_PORT ?? "587");
    const secure =
      z.enum(["true", "false"]).parse(env.SMTP_SECURE ?? String(port === 465)) === "true";
    const transport = nodemailer.createTransport({
      host: required("SMTP_HOST"),
      port,
      secure,
      requireTLS: !secure,
      auth: { user: required("SMTP_USER"), pass: required("SMTP_PASSWORD") },
      connectionTimeout: 15000,
      greetingTimeout: 15000,
      socketTimeout: 15000,
      logger: false,
      debug: false,
    });
    return {
      configured: true,
      async send(input) {
        try {
          const result = await transport.sendMail(message(input));
          if (!result.accepted.length) throw new Error("Recipient rejected");
        } catch {
          // SMTP errors may contain connection credentials or the message. Keep them private.
          throw new Error("Email delivery failed");
        }
      },
    };
  }
  const key = required("RESEND_API_KEY");
  return {
    configured: true,
    async send(input) {
      try {
        const response = await fetch("https://api.resend.com/emails", {
          method: "POST",
          headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
          body: JSON.stringify(message(input)),
          signal: AbortSignal.timeout(15000),
        });
        if (!response.ok) throw new Error("Provider rejected email");
      } catch {
        throw new Error("Email delivery failed");
      }
    },
  };
}
