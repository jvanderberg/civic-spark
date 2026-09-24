import nodemailer from "nodemailer";
import { z } from "zod";

export type LoginEmail = { email: string; url: string; code: string };
export type EmailDelivery = { configured: boolean; send: (message: LoginEmail) => Promise<void> };
type Message = { email: string; subject: string; text: string };

export const loginEmail = ({ email, url, code }: LoginEmail): Message => ({
  email,
  subject: `Civic Spark sign-in code: ${code}`,
  text: `Your Civic Spark sign-in code is ${code}\n\nEnter it where you requested it, or open this link to sign in:\n\n${url}\n\nThe code and link expire in 10 minutes. Each works once.\n\nIf you did not request this email, you can ignore it.`,
});

// Provider boundary: identity and event code depend only on EmailDelivery.
// Never log messages: sign-in codes and URLs are credentials.
export function createEmailDelivery(env: NodeJS.ProcessEnv = process.env): EmailDelivery {
  const sender = createEmailSender(env);
  return { configured: sender.configured, send: (input) => sender.send(loginEmail(input)) };
}

export function createEmailSender(env: NodeJS.ProcessEnv = process.env) {
  const provider = z
    .enum(["disabled", "resend", "smtp"])
    .parse(env.CIVIC_SPARK_EMAIL_PROVIDER ?? "disabled");
  if (provider === "disabled")
    return {
      configured: false,
      async send(_message: Message): Promise<void> {
        throw new Error("Email delivery is not configured");
      },
    };
  const required = (key: string): string => {
    const value = env[key];
    if (!value?.trim()) throw new Error(`${key} is required for ${provider} email delivery`);
    return value;
  };
  const from = required("CIVIC_SPARK_EMAIL_FROM");
  const message = ({ email, subject, text }: Message) => ({ from, to: [email], subject, text });
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
      async send(input: Message): Promise<void> {
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
    async send(input: Message): Promise<void> {
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
