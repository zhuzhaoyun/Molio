const LOGO_MAIN_URL = `${import.meta.env.BASE_URL}images/main.png`;

/** 正式品牌 logo（与官网 landing-page/images/new/main.png 同源）。全应用统一走这里，不再各自拼 URL。 */
export function BrandLogo({ className, alt = 'Molio' }: { className?: string; alt?: string }) {
  return <img className={className} src={LOGO_MAIN_URL} alt={alt} />;
}
