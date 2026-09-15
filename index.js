require("dotenv").config();

const { connectDb } = require("./src/db/mongo");
const { createApp } = require("./src/app");

async function main() {
  await connectDb();
  const app = createApp();
  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => {
    console.log(`Auto Report API listening on port ${PORT}`);
  });
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
