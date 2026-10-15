"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import type { MouseEvent, ReactNode } from "react";
import {
  BookOpen,
  LayoutGrid,
  Library as LibraryIcon,
  RefreshCw,
  type LucideIcon,
} from "lucide-react";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarHeader,
  SidebarInset,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
  SidebarTrigger,
  useSidebar,
} from "@/components/ui/sidebar";
import { AuthControls } from "@/components/premium/auth-boundary";
import { Brand } from "@/components/app/brand";

const MAIN_ID = "main-content";

// The desktop sidebar is always open (spec §6: the toggle exists on mobile only), so the primitive's Ctrl/Cmd+B
// shortcut, which would collapse it with no visible way back, changes nothing there. The mobile sheet is separate state.
const keepSidebarOpen = () => {};

const DESTINATIONS: { href: string; label: string; icon: LucideIcon }[] = [
  { href: "/", label: "Overview", icon: LayoutGrid },
  { href: "/library", label: "Library", icon: LibraryIcon },
  { href: "/updates", label: "Updates", icon: RefreshCw },
  { href: "/getting-started", label: "Getting started", icon: BookOpen },
];

// Workspace frame: skip link, sidebar (sheet on mobile), slim top bar and the one focusable `main`.
export function Shell({ children }: { children: ReactNode }) {
  return (
    <>
      <a
        href={`#${MAIN_ID}`}
        onClick={(event) => {
          event.preventDefault();
          document.getElementById(MAIN_ID)?.focus();
        }}
        className="sr-only focus:not-sr-only focus:fixed focus:top-3 focus:left-3 focus:z-50 focus:rounded-lg focus:bg-(--paper-raised) focus:px-4 focus:py-2 focus:text-[15px] focus:font-semibold focus:text-(--cobalt) focus:outline-none focus:ring-2 focus:ring-(--cobalt) focus:ring-offset-2 focus:ring-offset-(--paper)"
      >
        Skip to content
      </a>
      <SidebarProvider open onOpenChange={keepSidebarOpen}>
        <WorkspaceSidebar />
        <SidebarInset className="@container min-w-0 bg-(--paper)">
          <TopBar />
          <main
            id={MAIN_ID}
            tabIndex={-1}
            className="flex-1 px-4 py-6 outline-none @3xl:px-8 @3xl:py-8"
          >
            {children}
          </main>
        </SidebarInset>
      </SidebarProvider>
    </>
  );
}

// A plain activation closes the mobile sheet; modified clicks (new tab or window) keep it open.
function useCloseOnActivation() {
  const { isMobile, setOpenMobile } = useSidebar();
  return (event: MouseEvent<HTMLAnchorElement>) => {
    if (
      event.button !== 0 ||
      event.metaKey ||
      event.ctrlKey ||
      event.shiftKey ||
      event.altKey
    )
      return;
    if (isMobile) setOpenMobile(false);
  };
}

function WorkspaceSidebar() {
  const pathname = usePathname();
  const close = useCloseOnActivation();
  return (
    <Sidebar
      data-component="shell"
      className="border-(--rule) [&>[data-slot=sidebar-inner]]:bg-(--paper-raised)/85 [&>[data-slot=sidebar-inner]]:backdrop-blur-md"
    >
      <SidebarHeader className="px-5 pt-6 pb-4">
        <nav aria-label="Home">
          <Brand onClick={close} />
        </nav>
      </SidebarHeader>
      <SidebarContent>
        <nav aria-label="Workspace">
          <SidebarGroup className="px-3">
            <SidebarGroupContent>
              <SidebarMenu className="gap-1.5">
                {DESTINATIONS.map(({ href, label, icon: Icon }) => {
                  const current = pathname === href;
                  return (
                    <SidebarMenuItem key={href}>
                      <SidebarMenuButton
                        asChild
                        isActive={current}
                        className="h-10 gap-3 rounded-full px-3.5 text-[15px] leading-6 font-medium text-(--ink) focus-visible:ring-(--cobalt) hover:bg-(--cobalt-soft) hover:text-(--ink-title) active:bg-(--cobalt-soft) active:text-(--ink-title) data-[active=true]:bg-(--cobalt-soft) data-[active=true]:font-semibold data-[active=true]:text-(--cobalt) [&>svg]:size-[18px]"
                      >
                        <Link
                          href={href}
                          aria-current={current ? "page" : undefined}
                          onClick={close}
                        >
                          <Icon aria-hidden="true" strokeWidth={2} />
                          <span>{label}</span>
                        </Link>
                      </SidebarMenuButton>
                    </SidebarMenuItem>
                  );
                })}
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
        </nav>
      </SidebarContent>
      <SidebarFooter className="border-t border-(--rule) px-4 py-4">
        <section
          aria-label="Account"
          className="[&_.account-controls]:justify-end"
        >
          <AuthControls />
        </section>
      </SidebarFooter>
    </Sidebar>
  );
}

function TopBar() {
  const { openMobile } = useSidebar();
  return (
    <header className="flex h-14 shrink-0 items-center gap-2 border-b border-(--rule) px-4 @3xl:px-8">
      <SidebarTrigger
        aria-label="Toggle navigation"
        aria-expanded={openMobile}
        className="-ml-1.5 size-9 text-(--ink-title) hover:bg-(--cobalt-soft) hover:text-(--ink-title) focus-visible:ring-2 focus-visible:ring-(--cobalt) md:hidden"
      />
      <p className="text-[13px] leading-[18px] font-medium text-(--ink-muted)">
        Your knowledge workspace
      </p>
    </header>
  );
}
