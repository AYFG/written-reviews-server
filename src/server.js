import app from "./app.js";

const PORT = process.env.PORT || 5001;

const server = app.listen(PORT, () => {
  console.log(`✅ Written Reviews Server is running on http://localhost:${PORT}`);
});
