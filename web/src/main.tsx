import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "@nimbus-ds/styles/dist/index.css"; // ESTOY SUPONIENDO esta ruta del CSS de Nimbus; verificar tras npm install.
import App from "./App";
import { initNexo } from "./nexo";

// El handshake con el admin tiene un timeout corto (3 s por defecto): se inicia antes de montar React.
initNexo().catch(() => undefined); // el error real se muestra al pedir el token (api.ts -> App)

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
