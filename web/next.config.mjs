/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // /progress 는 /project 로 합쳐졌다. 북마크와 예전 메일 링크가 죽지 않도록 남긴다.
  // config 리다이렉트는 쿼리스트링을 그대로 넘겨주므로 딥링크(?rfq=5&stage=4)가 살아있다.
  // permanent:false — 영구(308)로 두면 브라우저가 캐시해 되돌리기 어려워진다.
  async redirects() {
    return [{ source: "/progress", destination: "/project", permanent: false }];
  },
};

export default nextConfig;
