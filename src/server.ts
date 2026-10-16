import { httpServer } from "./app";

const PORT = 3000;

httpServer.listen(PORT, () => {
  console.log(`Reminder API listening on http://localhost:${PORT}`);
});
