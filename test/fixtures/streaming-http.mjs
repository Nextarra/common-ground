// Local test preload: prevents all real HTTP and simulates a never-ending body.
// Used only with an unmistakably fake contract-test key in a child process.
if (process.env.QLOO_API_KEY !== "CONTRACT_FIXTURE_NOT_A_REAL_KEY")
  throw new Error("Fixture key required");
globalThis.fetch = async (url) => {
  if (new URL(url).origin !== "https://api.qloo.com")
    throw new Error("Unexpected fixture URL");
  process.stderr.write("FIXTURE_HTTP_STARTED\n");
  return new Response(
    new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"results":'));
      },
    }),
    { status: 200 },
  );
};
setInterval(() => {}, 1000);
