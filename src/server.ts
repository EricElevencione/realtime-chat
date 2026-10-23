import { httpServer } from "./app.js";

const PORT = Number(process.env.PORT) || 3000;
const HOST = "0.0.0.0";

httpServer.listen(PORT, HOST, () => {
  console.log(`Real-Time Chat API listening on http://${HOST}:${PORT}`);
});
