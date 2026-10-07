import type { Metadata } from "next";
import { SiteHeader } from "@/components/layout/SiteHeader";
import { SiteFooter } from "@/components/layout/SiteFooter";
import { Container } from "@/components/ui/Container";
import { ContactLink } from "@/components/ui/ContactLink";
import { BOOKING_POLICY, POLICY_LINKS } from "@/config/site";
import { normaliseReference } from "@/domain/booking/withdrawal";
import { WithdrawalForm } from "./WithdrawalForm";

/**
 * "Withdraw from contract here": the online way for a UK or EU consumer to
 * cancel within the 14 days, which the law asks to be available the whole
 * time. Linked from every booking email and the footer of every page here.
 *
 * Under /training/book/ so it is served with the per-request nonce policy, like
 * every other page that takes personal details.
 */

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Withdraw from contract here",
  robots: { index: false, follow: false },
};

export default async function WithdrawPage({ searchParams }: PageProps<"/training/book/withdraw">) {
  const { ref } = await searchParams;
  // Prefilled from the link in a booking email; anything that is not a reference is dropped.
  const initialReference = typeof ref === "string" ? (normaliseReference(ref) ?? "") : "";

  return (
    <>
      <SiteHeader />
      <main id="main" className="py-16 sm:py-24">
        <Container>
          <div className="mx-auto grid max-w-[1000px] gap-12 lg:grid-cols-[1fr_420px]">
            <div>
              <h1 className="text-ink mb-6 font-serif text-[clamp(34px,4.2vw,46px)] leading-[1.1] font-[450] tracking-[-0.02em] text-balance">
                Cancel your booking
              </h1>
              <p className="text-ink-soft text-[17px] leading-[1.65]">
                If you live in the United Kingdom or the European Union and booked a session for
                yourself, you can cancel within {BOOKING_POLICY.cancellationDays} days of booking,
                without giving a reason. If your session has not started, we refund the full price
                within {BOOKING_POLICY.withdrawalRefundDays} days, to the card you paid with.
              </p>
              <p className="text-ink-muted mt-4 text-[15px] leading-[1.65]">
                Fill in the form, check the details, then confirm. We confirm by email straight
                away. You can also cancel by emailing <ContactLink showAddress />.
              </p>
              <p className="text-ink-muted mt-4 text-[15px] leading-[1.65]">
                Not in the UK or EU, booked for your business, or want to move your session instead?
                The{" "}
                <a
                  href={POLICY_LINKS.bookingAndRefunds}
                  className="text-accent underline underline-offset-[3px]"
                >
                  Booking and Refund Policy
                </a>{" "}
                explains your options.
              </p>
            </div>
            <WithdrawalForm initialReference={initialReference} />
          </div>
        </Container>
      </main>
      <SiteFooter />
    </>
  );
}
