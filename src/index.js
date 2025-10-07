import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App'; // Importa el componente principal ExpenseTracker (ahora App.jsx)

// 1. Obtiene el contenedor principal del DOM (el <div id="root"> en index.html)
const container = document.getElementById('root');

// 2. Verifica si el contenedor existe
if (container) {
    // 3. Crea la raíz de React
    const root = createRoot(container);
    
    // 4. Renderiza el componente principal App dentro de la raíz
    root.render(
        <React.StrictMode>
            <App />
        </React.StrictMode>
    );
} else {
    // Esto solo debería ocurrir si el index.html está incorrecto
    console.error("No se pudo encontrar el elemento 'root' en el DOM.");
}
