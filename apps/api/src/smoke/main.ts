import { runSmokeCli } from "./cli.js";

runSmokeCli(process.argv.slice(2), process.env, { write: (text) => void process.stdout.write(text) }).then(
  (code) => process.exit(code),
  () => {
    // Never print the raw error: it could contain request details.
    process.stderr.write("Smoke run crashed unexpectedly.\n");
    process.exit(2);
  },
);
