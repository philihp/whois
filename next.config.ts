import { withWorkflow } from 'workflow/next';
import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  reactStrictMode: true,
};

// Enables the "use workflow" / "use step" directives used by workflows/.
export default withWorkflow(nextConfig);
