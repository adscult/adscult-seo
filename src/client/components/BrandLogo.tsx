import { cn } from "cn";

export function BrandLogo({
  className,
  alt = "AdsCult",
  appearance = "auto",
}: {
  className?: string;
  alt?: string;
  appearance?: "auto" | "light" | "dark";
}) {
  const logoClassName = cn("object-contain", className);
  if (appearance === "dark") {
    return (
      <img
        src="/adscult-footer-logo.webp"
        alt={alt}
        className={logoClassName}
      />
    );
  }
  if (appearance === "light") {
    return <img src="/adscult-logo.webp" alt={alt} className={logoClassName} />;
  }
  return (
    <>
      <img
        src="/adscult-logo.webp"
        alt={alt}
        className={cn("adscult-logo-light", logoClassName)}
      />
      <img
        src="/adscult-footer-logo.webp"
        alt={alt}
        className={cn("adscult-logo-dark", logoClassName)}
      />
    </>
  );
}

export function BrandLockup({
  className,
  logoClassName,
  appearance = "auto",
}: {
  className?: string;
  logoClassName?: string;
  appearance?: "auto" | "light" | "dark";
}) {
  return (
    <div className={cn("flex min-w-0 items-center gap-2", className)}>
      <BrandLogo
        className={cn("h-6 w-auto", logoClassName)}
        appearance={appearance}
        alt="AdsCult"
      />
      <span className="rounded-md bg-primary/10 px-1.5 py-1 text-[10px] font-bold tracking-[0.12em] text-primary">
        SEO
      </span>
    </div>
  );
}
