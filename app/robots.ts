import { MetadataRoute } from "next";

// Internal tool: nothing on this host should be indexed.
export default function robots(): MetadataRoute.Robots {
  return {
    rules: [{ userAgent: "*", disallow: ["/"] }],
  };
}
