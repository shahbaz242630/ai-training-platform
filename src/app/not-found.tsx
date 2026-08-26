import { Container } from "@/components/ui/Container";
import { ButtonLink } from "@/components/ui/Button";

export default function NotFound() {
  return (
    <main id="main" className="flex min-h-[70vh] items-center py-24">
      <Container>
        <p className="text-ink-faint text-xs font-semibold tracking-[0.18em] uppercase">
          Error 404
        </p>
        <h1 className="text-ink mt-4 text-3xl font-semibold tracking-[-0.03em] sm:text-4xl">
          We couldn’t find that page.
        </h1>
        <p className="text-ink-muted mt-5 max-w-md text-base leading-relaxed">
          The link may be out of date, or the page may have moved.
        </p>
        <div className="mt-9">
          <ButtonLink href="/training">View the sessions</ButtonLink>
        </div>
      </Container>
    </main>
  );
}
