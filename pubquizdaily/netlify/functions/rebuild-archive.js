// netlify/functions/rebuild-archive.js
// Scheduled function — fires once a day and triggers a fresh Netlify build by
// pinging a build hook. The build then runs the generate-archive plugin, which
// regenerates the weekly pages, archive.html and sitemap.xml with any new days.
//
// Why a build hook instead of writing files here? Scheduled functions run in a
// serverless sandbox and can't write into the deployed site. Pinging the build
// hook is a one-line, no-credentials-in-code way to kick a normal build that
// CAN publish files.
//
// Setup:
//   1. Netlify dashboard → Site settings → Build & deploy → Build hooks →
//      "Add build hook", name it e.g. "daily-archive". Copy the URL.
//   2. Add it as an env var BUILD_HOOK_URL (Site settings → Environment vars).
//   3. Deploy. The schedule below runs at 05:30 UTC daily (before your 6am
//      daily-report email, so the archive is fresh when stats go out).

export default async function handler() {
  const hook = process.env.BUILD_HOOK_URL;
  if (!hook) {
    console.error('BUILD_HOOK_URL not set — cannot trigger rebuild');
    return new Response('Missing BUILD_HOOK_URL', { status: 500 });
  }
  try {
    const res = await fetch(hook, { method: 'POST' });
    console.log('Build hook pinged, status', res.status);
    return new Response('Triggered', { status: 200 });
  } catch (err) {
    console.error('Failed to ping build hook:', err);
    return new Response('Failed', { status: 500 });
  }
}

export const config = {
  schedule: '30 5 * * *', // 05:30 UTC daily
};
