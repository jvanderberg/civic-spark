import nodemailer from "nodemailer";
import { afterEach, expect, it, vi } from "vitest";
import { createEmailDelivery } from "../apps/server/src/email.ts";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
const message = {
  email: "person@example.test",
  url: "https://event.example/sign-in?token=test-only",
};

it("requires explicit provider selection and complete configuration", async () => {
  const disabled = createEmailDelivery({});
  expect(disabled.configured).toBe(false);
  await expect(disabled.send(message)).rejects.toThrow("not configured");
  expect(() => createEmailDelivery({ VIBEHACK_EMAIL_PROVIDER: "unknown" })).toThrow();
  expect(() =>
    createEmailDelivery({
      VIBEHACK_EMAIL_PROVIDER: "resend",
      VIBEHACK_EMAIL_FROM: "Event <hello@example.test>",
    }),
  ).toThrow("RESEND_API_KEY is required");
});

it("sends through Resend and reports provider failures without leaking their response", async () => {
  const fetch = vi
    .fn()
    .mockResolvedValueOnce(new Response('{"id":"test"}', { status: 200 }))
    .mockResolvedValueOnce(new Response("sensitive provider diagnostic", { status: 429 }));
  vi.stubGlobal("fetch", fetch);
  const delivery = createEmailDelivery({
    VIBEHACK_EMAIL_PROVIDER: "resend",
    VIBEHACK_EMAIL_FROM: "hello@example.test",
    RESEND_API_KEY: "test-only",
  });
  await delivery.send(message);
  const sent = JSON.parse(fetch.mock.calls[0]?.[1].body);
  expect(sent.to).toEqual([message.email]);
  expect(sent.text).toContain(message.url);
  await expect(delivery.send(message)).rejects.toThrow(/^Email delivery failed$/);
});

it.each([587, 465])(
  "requires encrypted SMTP on port %s and propagates failed delivery safely",
  async (port) => {
    const sendMail = vi
      .fn()
      .mockResolvedValueOnce({ accepted: [message.email] })
      .mockResolvedValueOnce({ accepted: [] })
      .mockRejectedValueOnce(new Error("sensitive SMTP diagnostic"));
    const createTransport = vi
      .spyOn(nodemailer, "createTransport")
      .mockReturnValue({ sendMail } as unknown as ReturnType<typeof nodemailer.createTransport>);
    const delivery = createEmailDelivery({
      VIBEHACK_EMAIL_PROVIDER: "smtp",
      VIBEHACK_EMAIL_FROM: "hello@example.test",
      SMTP_HOST: "smtp.example.test",
      SMTP_PORT: String(port),
      SMTP_USER: "test-user",
      SMTP_PASSWORD: "test-only",
    });
    expect(createTransport).toHaveBeenCalledWith(
      expect.objectContaining({ secure: port === 465, requireTLS: port !== 465 }),
    );
    await delivery.send(message);
    expect(sendMail).toHaveBeenCalledWith(
      expect.objectContaining({ to: [message.email], text: expect.stringContaining(message.url) }),
    );
    await expect(delivery.send(message)).rejects.toThrow(/^Email delivery failed$/);
    await expect(delivery.send(message)).rejects.toThrow(/^Email delivery failed$/);
  },
);
