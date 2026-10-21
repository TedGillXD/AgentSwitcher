import type { Plugin } from 'vite';

/** React Fast Refresh injects an inline preamble in dev. Production keeps strict CSP. */
export function developmentCsp(): Plugin {
  return {
    name: 'agent-switcher-development-csp',
    apply: 'serve',
    transformIndexHtml(html) {
      return html.replace("script-src 'self';", "script-src 'self' 'unsafe-inline';");
    },
  };
}
