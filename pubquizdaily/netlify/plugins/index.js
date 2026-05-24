// netlify/plugins/generate-archive/index.js
// Netlify build plugin — runs the static archive generator during every build.
// Wire it up in netlify.toml (see the snippet in ARCHIVE-SETUP.md).
//
// It runs AFTER the build but the generated files are placed into the publish
// directory so they're deployed. We read PUBLISH_DIR from the Netlify config.

const path = require('path');
const { execFileSync } = require('child_process');

module.exports = {
  onPostBuild: async ({ constants, utils }) => {
    const publishDir = constants.PUBLISH_DIR || '.';
    // Prefer the deploy's own URL so we fetch the freshest question data.
    // DEPLOY_PRIME_URL is set by Netlify; fall back to the production URL.
    const siteUrl = process.env.URL || 'https://pubquizdaily.com';
    const apiBase = process.env.DEPLOY_PRIME_URL || process.env.URL || siteUrl;

    console.log('[generate-archive] publishDir=%s apiBase=%s', publishDir, apiBase);

    try {
      execFileSync('node', [path.join(__dirname, '..', '..', '..', 'build-archive.js')], {
        stdio: 'inherit',
        env: {
          ...process.env,
          PUBLISH_DIR: publishDir,
          SITE_URL: siteUrl,
          API_BASE: apiBase,
        },
      });
    } catch (err) {
      // Don't fail the whole deploy if archive generation hiccups — the live
      // site still works. Surface it as a plugin error for visibility.
      return utils.build.failPlugin('Archive generation failed', { error: err });
    }
  },
};
