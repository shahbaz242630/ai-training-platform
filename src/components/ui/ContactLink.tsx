import { SITE, supportEmail } from "@/config/site";

/**
 * The one way a page asks a customer to contact us: a mailto link to the
 * booking desk's mailbox. Before this, "get in touch" appeared on the booking
 * pages with nowhere to go.
 *
 * While the address is not configured there is nothing honest to link to, so
 * the words render as plain text rather than a mailto to a placeholder.
 */
interface ContactLinkProps {
  /** Show the address itself as the link text instead of "get in touch". */
  readonly showAddress?: boolean;
}

export function ContactLink({ showAddress = false }: ContactLinkProps) {
  const text = showAddress ? supportEmail() : "get in touch";
  if (!SITE.supportEmail) return <>{text}</>;
  return (
    <a
      href={`mailto:${SITE.supportEmail}`}
      className="text-ink underline decoration-1 underline-offset-2 hover:no-underline"
    >
      {text}
    </a>
  );
}

/** The same request in a plain-text message, where a link cannot go. */
export function contactLine(): string {
  return `email ${supportEmail()}`;
}
