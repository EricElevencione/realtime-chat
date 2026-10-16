import { io } from "socket.io-client";

const token =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJ1c2VySWQiOjEsImlhdCI6MTc5MjExOTI0MCwiZXhwIjoxNzkyMTIyODQwfQ.MtpUl2i-1dTAG1NfAC9oEnxUwtjVD0YJMcWM3kjZ5dA";

const socket = io("http://localhost:3000", {
  auth: {
    token,
  },
});

const conversationId = "1";

socket.on("connect", () => {
  console.log("Connected:", socket.id);
  socket.emit("joinConversation", conversationId);
});

socket.on("joinedConversation", (conversationId) => {
  console.log("Joined:", conversationId);

  socket.emit("sendMessage", {
    conversationId,
    message: "Hello from the client!",
  });
});

socket.on("disconnect", (reason) => {
  console.log("Disconnected from the server. Reason:", reason);
});

socket.on("messageReceived", (message) => {
  console.log("Message received:", message);
});

socket.on("connect_error", (error) => {
  console.log("Connection rejected:", error.message);
});
