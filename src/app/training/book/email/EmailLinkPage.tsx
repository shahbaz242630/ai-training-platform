import { SiteHeader } from "@/components/layout/SiteHeader";
import { SiteFooter } from "@/components/layout/SiteFooter";
import { Container } from "@/components/ui/Container";
import { ContactLink } from "@/components/ui/ContactLink";
import type { EmailLinkPurpose } from "@/lib/email-link";
import type { LinkOutcome } from "./actions";

/**
 * The page behind both email links: one short explanation and one button.
 * Opening it changes nothing; the button posts the link back. After the
 * button, it shows the outcome and no button, so nothing is pressed twice.
 */

const PRIMARY =
  "bg-ink hover:bg-deep-soft text-on-deep mt-6 w-full rounded-full px-6 py-3.5 text-[15.5px] font-medium transition-colors duration-150 sm:w-auto";

const WORDS: Readonly<
  Record<
    EmailLinkPurpose,
    { readonly title: string; readonly ask: string; readonly button: string; readonly done: string }
  >
> = {
  confirm: {
    title: "Confirm emails about new sessions",
    ask: "You asked to hear from us occasionally about new sessions. Press the button to confirm that this is your email address.",
    button: "Yes, send me occasional emails",
    done: "Thank you, that is confirmed. We will email you occasionally about new sessions, and every one of those emails has a link to stop them.",
  },
  unsubscribe: {
    title: "Stop emails about new sessions",
    ask: "Press the button and we will stop emailing you about new sessions. Emails about a session you have booked still arrive.",
    button: "Unsubscribe",
    done: "You are unsubscribed. We will not email you about new sessions again. Emails about a session you have booked still arrive.",
  },
};

export interface EmailLinkPageProps {
  readonly purpose: EmailLinkPurpose;
  /** The link's token when it would work, else null. */
  readonly token: string | null;
  readonly outcome: LinkOutcome | null;
  readonly action: (form: FormData) => Promise<void>;
}

export function EmailLinkPage({ purpose, token, outcome, action }: EmailLinkPageProps) {
  const words = WORDS[purpose];
  return (
    <>
      <SiteHeader />
      <main id="main" className="py-16 sm:py-24">
        <Container>
          <div className="mx-auto max-w-[640px]">
            <h1 className="text-ink mb-6 font-serif text-[clamp(30px,4vw,42px)] leading-[1.1] font-[450] tracking-[-0.02em] text-balance">
              {words.title}
            </h1>
            <Body words={words} token={token} outcome={outcome} action={action} />
          </div>
        </Container>
      </main>
      <SiteFooter />
    </>
  );
}

function Body({
  words,
  token,
  outcome,
  action,
}: {
  readonly words: (typeof WORDS)[EmailLinkPurpose];
  readonly token: string | null;
  readonly outcome: LinkOutcome | null;
  readonly action: (form: FormData) => Promise<void>;
}) {
  const paragraph = "text-ink-soft text-[17px] leading-[1.65]";
  if (outcome === "done") return <p className={paragraph}>{words.done}</p>;
  if (outcome === "busy") {
    return <p className={paragraph}>Too many attempts. Please try again in a minute.</p>;
  }
  if (outcome === "error") {
    return (
      <p className={paragraph}>
        Something went wrong on our side. Please try the link again in a moment, or email{" "}
        <ContactLink showAddress />.
      </p>
    );
  }
  if (outcome === "invalid" || token === null) {
    return (
      <p className={paragraph}>
        This link did not work. If you copied it from the email, check that you copied all of it, or
        email <ContactLink showAddress />.
      </p>
    );
  }
  return (
    <form action={action}>
      <p className={paragraph}>{words.ask}</p>
      <input type="hidden" name="token" value={token} />
      <button type="submit" className={PRIMARY}>
        {words.button}
      </button>
    </form>
  );
}
