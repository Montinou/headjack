import Image from "next/image";
import { SignInButton, SignUpButton } from "@clerk/nextjs";
import { Button } from "@/components/ui/button";

// Signed-out hero: copy and controls only, no private reads.
// Splits into two columns from 1024px of content width (container query), about a 1344px viewport with the sidebar;
// stacked below, where the image fills the content column, so `sizes` follows that column.
export function Introduction() {
  return (
    <section
      data-screen="introduction"
      aria-labelledby="introduction-title"
      className="@container w-full"
    >
      <div className="mx-auto grid w-full max-w-6xl gap-8 py-6 @5xl:grid-cols-[minmax(0,5fr)_minmax(0,6fr)] @5xl:items-center @5xl:gap-14 @5xl:py-12">
        <div className="flex flex-col gap-5">
          <h1
            id="introduction-title"
            className="text-[30px] leading-9 font-extrabold tracking-[-0.02em] text-(--ink-title) @2xl:text-[40px] @2xl:leading-[44px]"
          >
            A private home for your skills.
          </h1>
          <p className="max-w-xl text-[17px] leading-7 text-(--ink)">
            Browse, review and use your agent knowledge in one place.
          </p>
          <p className="max-w-xl border-t border-(--rule) pt-4 text-[15px] leading-6 text-(--ink-muted)">
            Your library is private: only your signed-in account can read it,
            and access is by invitation.
          </p>
          <div className="flex flex-wrap gap-3 pt-1">
            <SignInButton mode="modal">
              <Button>Sign in</Button>
            </SignInButton>
            <SignUpButton mode="modal">
              <Button variant="outline" className="shadow-none">
                Accept invitation
              </Button>
            </SignUpButton>
          </div>
        </div>
        <div className="paper-card overflow-hidden p-0">
          <Image
            src="/images/headjack/knowledge-archive-v1.webp"
            alt=""
            width={1536}
            height={1024}
            loading="eager"
            sizes="(min-width: 1344px) 600px, (min-width: 1024px) calc(100vw - 320px), (min-width: 768px) calc(100vw - 288px), 100vw"
            className="block h-auto w-full"
          />
        </div>
      </div>
    </section>
  );
}
