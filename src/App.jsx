import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { getFirestore, collection, query, onSnapshot, addDoc, deleteDoc, getDocs, Timestamp, doc, updateDoc } from 'firebase/firestore';
import { initializeApp } from 'firebase/app';
import { getAuth, signInAnonymously, signInWithCustomToken, onAuthStateChanged } from 'firebase/auth';
import { DollarSign, Tag, Calendar, Loader2, Send, Zap, User, BarChart4, Archive, RotateCcw, XCircle, SquarePen } from 'lucide-react';

// --- Configuración de Firebase y Variables Globales (Ajustadas para Despliegue) ---
/*
    IMPORTANTE PARA EL DEPLOY (Vercel):
    En un entorno de despliegue, NO existen las variables globales como __firebase_config. 
    Por ello, el código ahora intenta leer la configuración desde una variable de entorno:
    process.env.REACT_APP_FIREBASE_CONFIG.

    Instrucción: Debes establecer la variable de entorno REACT_APP_FIREBASE_CONFIG en Vercel.
*/
const rawFirebaseConfig = typeof __firebase_config !== 'undefined' 
    ? __firebase_config // Lee del entorno Canvas si está disponible
    : (process.env.REACT_APP_FIREBASE_CONFIG || '{}'); // Lee de ENV en despliegue

// Intenta parsear la configuración si existe
const firebaseConfig = rawFirebaseConfig ? JSON.parse(rawFirebaseConfig) : {};

// Usamos un ID de App genérico si no se proporciona uno (necesario para el path de Firestore)
const appId = typeof __app_id !== 'undefined' 
    ? __app_id 
    : (process.env.REACT_APP_APP_ID || 'expense-tracker-prod'); 

// El token de autenticación inicial no se usa en despliegues reales
const initialAuthToken = null; 

// URL del API de Gemini (Usaremos gemini-2.5-flash-preview-05-20 para texto y estructurado)
const GEMINI_API_URL = "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-preview-05-20:generateContent";
const API_KEY = ""; // La clave se provee automáticamente en el entorno

// Función de utilidad para manejar el backoff exponencial en las llamadas API
const fetchWithBackoff = async (url, options, retries = 3, delay = 1000) => {
    try {
        const response = await fetch(url, options);
        if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status}`);
        }
        return await response.json();
    } catch (error) {
        if (retries > 0) {
            await new Promise(res => setTimeout(res, delay));
            return fetchWithBackoff(url, options, retries - 1, delay * 2);
        }
        console.error("Fallo de fetch después de varios reintentos:", error);
        throw error;
    }
};

// Mapeo de colores para las categorías (para el gráfico)
const CATEGORY_COLORS = {
    'Comida': 'bg-red-500',
    'Transporte': 'bg-blue-500',
    'Entretenimiento': 'bg-purple-500',
    'Vivienda': 'bg-green-500',
    'Salud': 'bg-pink-500',
    'Educación': 'bg-yellow-500',
    'Servicios': 'bg-cyan-500',
    'Otros': 'bg-gray-500',
    'No Categorizado': 'bg-orange-500',
};

// --- Componente Principal ---
const App = () => {
    // Estado de la aplicación
    const [db, setDb] = useState(null);
    const [auth, setAuth] = useState(null);
    const [userId, setUserId] = useState(null);
    const [isAuthReady, setIsAuthReady] = useState(false);
    const [expenses, setExpenses] = useState([]);
    const [history, setHistory] = useState([]); 
    const [amount, setAmount] = useState('');
    const [description, setDescription] = useState('');
    const [isLoading, setIsLoading] = useState(false);
    const [error, setError] = useState(null);
    const [isArchiving, setIsArchiving] = useState(false); 

    // --- Nuevos estados para la edición ---
    const [isEditing, setIsEditing] = useState(false);
    const [editingExpenseId, setEditingExpenseId] = useState(null);
    const [editingOriginalDescription, setEditingOriginalDescription] = useState(''); 

    // 1. Inicialización de Firebase y Autenticación
    useEffect(() => {
        // Verifica si la configuración es válida antes de inicializar Firebase
        if (!firebaseConfig || !firebaseConfig.projectId) {
            console.warn("Configuración de Firebase faltante. La App solo funcionará en entornos que la inyecten o si se proporciona la ENV 'REACT_APP_FIREBASE_CONFIG'.");
            setIsAuthReady(true);
            return;
        }

        try {
            const app = initializeApp(firebaseConfig);
            const firestore = getFirestore(app);
            const authInstance = getAuth(app);

            setDb(firestore);
            setAuth(authInstance);

            const unsubscribe = onAuthStateChanged(authInstance, async (user) => {
                if (user) {
                    setUserId(user.uid);
                    setIsAuthReady(true);
                } else {
                    try {
                        // En producción, si no hay token inicial, se inicia sesión anónima
                        if (initialAuthToken) {
                            await signInWithCustomToken(authInstance, initialAuthToken);
                        } else {
                            await signInAnonymously(authInstance);
                        }
                    } catch (e) {
                        console.error("Error en la autenticación inicial:", e);
                        // Fallback a ID aleatorio si la autenticación anónima falla
                        setUserId(crypto.randomUUID());
                        setIsAuthReady(true);
                    }
                }
            });

            return () => unsubscribe();
        } catch (e) {
            console.error("Error al inicializar Firebase:", e);
            setIsAuthReady(true); 
            setError("Error crítico de configuración. Revisa la consola.");
        }
    }, []);

    // 2. Listener de Firestore (Recuperación de Gastos y Historial en Tiempo Real)
    useEffect(() => {
        if (db && userId && isAuthReady) {
            // Listener para gastos actuales
            const expensesCollectionPath = `/artifacts/${appId}/users/${userId}/expenses`;
            const qExpenses = query(collection(db, expensesCollectionPath));

            const unsubscribeExpenses = onSnapshot(qExpenses, (snapshot) => {
                const fetchedExpenses = snapshot.docs.map(doc => ({
                    id: doc.id,
                    ...doc.data(),
                    category: doc.data().category || 'No Categorizado',
                    date: doc.data().timestamp?.toDate() || new Date()
                }));
                // Ordenar por fecha de creación más reciente
                fetchedExpenses.sort((a, b) => b.date - a.date); 
                setExpenses(fetchedExpenses);
                setError(null);
            }, (err) => {
                console.error("Error al escuchar los gastos:", err);
                setError("No se pudieron cargar los datos de gastos. Revisa la consola.");
            });

            // Listener para historial de resúmenes
            const historyCollectionPath = `/artifacts/${appId}/users/${userId}/history`;
            const qHistory = query(collection(db, historyCollectionPath));

            const unsubscribeHistory = onSnapshot(qHistory, (snapshot) => {
                const fetchedHistory = snapshot.docs.map(doc => ({
                    id: doc.id,
                    ...doc.data(),
                    archiveDate: doc.data().archiveDate?.toDate() || new Date()
                }));
                // Ordenar por fecha de archivado más reciente primero
                fetchedHistory.sort((a, b) => b.archiveDate - a.archiveDate); 
                setHistory(fetchedHistory);
            }, (err) => {
                console.error("Error al escuchar el historial:", err);
            });


            return () => {
                unsubscribeExpenses();
                unsubscribeHistory();
            };
        }
    }, [db, userId, isAuthReady]);

    // 3. Función de Categorización con Gemini API
    const categorizeExpense = useCallback(async (text) => {
        const systemPrompt = "Eres un asistente financiero experto. Tu tarea es analizar la descripción de un gasto y asignar una 'category' (categoría general en español, ej: 'Comida', 'Transporte', 'Entretenimiento', 'Vivienda', 'Salud', 'Educación', 'Servicios', 'Otros') y una 'classification' (clasificación detallada en español, ej: 'Restaurante', 'Gasolina', 'Cine', 'Alquiler', 'Supermercado'). La respuesta DEBE ser un objeto JSON con las claves 'category' y 'classification'.";
        const userQuery = `Gasto: "${text}". Categoriza y clasifica este gasto.`;

        const payload = {
            contents: [{ parts: [{ text: userQuery }] }],
            systemInstruction: { parts: [{ text: systemPrompt }] },
            generationConfig: {
                responseMimeType: "application/json",
                responseSchema: {
                    type: "OBJECT",
                    properties: {
                        "category": { "type": "STRING", description: "La categoría general del gasto (ej: Comida)" },
                        "classification": { "type": "STRING", description: "La clasificación detallada del gasto (ej: Restaurante)" }
                    },
                    required: ["category", "classification"],
                }
            }
        };

        const options = {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        };

        try {
            const result = await fetchWithBackoff(`${GEMINI_API_URL}?key=${API_KEY}`, options);
            const jsonText = result.candidates?.[0]?.content?.parts?.[0]?.text;
            if (jsonText) {
                return JSON.parse(jsonText);
            }
            throw new Error("Respuesta de la API vacía o no estructurada.");
        } catch (e) {
            console.error("Error al categorizar con Gemini:", e);
            return { category: 'No Categorizado', classification: 'Manual' };
        }
    }, []);

    // Manejador para cancelar la edición
    const handleCancelEdit = () => {
        setIsEditing(false);
        setEditingExpenseId(null);
        setAmount('');
        setDescription('');
        setEditingOriginalDescription('');
        setError(null);
    };

    // Manejador para iniciar la edición
    const handleEditClick = (expense) => {
        setError(null);
        setIsEditing(true);
        setEditingExpenseId(expense.id);
        setAmount(expense.amount.toString());
        setDescription(expense.description);
        setEditingOriginalDescription(expense.description);
        // Scroll para mejor UX en móvil/pantallas pequeñas
        document.querySelector('.sticky.top-4').scrollIntoView({ behavior: 'smooth' });
    };


    // 4. Manejador de Envío de Gasto (Añadir o Editar)
    const handleSubmit = async (e) => {
        e.preventDefault();

        const numericAmount = parseFloat(amount.replace(/[^0-9.]/g, ''));

        if (!numericAmount || numericAmount <= 0 || !description.trim()) {
            setError("Por favor, introduce un monto válido y una descripción.");
            return;
        }

        if (!db || !userId) {
            setError("La aplicación no está lista aún. Por favor, espera un momento.");
            return;
        }

        setIsLoading(true);
        setError(null);

        try {
            if (isEditing) {
                // --- Lógica de Edición ---
                const expenseDocPath = `/artifacts/${appId}/users/${userId}/expenses/${editingExpenseId}`;
                const expenseRef = doc(db, expenseDocPath);
                let updatedFields = {
                    amount: numericAmount,
                    description: description.trim(),
                };

                // Recategorizar solo si la descripción ha cambiado
                if (description.trim() !== editingOriginalDescription) {
                    console.log("Descripción cambiada, recategorizando...");
                    const { category, classification } = await categorizeExpense(description);
                    updatedFields.category = category;
                    updatedFields.classification = classification;
                }

                await updateDoc(expenseRef, updatedFields);

                // Resetear estado de edición
                handleCancelEdit(); 
                console.log("Gasto actualizado con éxito.");

            } else {
                // --- Lógica de Añadir ---
                const { category, classification } = await categorizeExpense(description);

                const newExpense = {
                    amount: numericAmount,
                    description: description.trim(),
                    category: category,
                    classification: classification,
                    timestamp: Timestamp.now(),
                };

                const expensesCollectionPath = `/artifacts/${appId}/users/${userId}/expenses`;
                await addDoc(collection(db, expensesCollectionPath), newExpense);

                setAmount('');
                setDescription('');
            }
        } catch (e) {
            console.error(`Error al ${isEditing ? 'actualizar' : 'guardar'} el gasto:`, e);
            setError(`Error al procesar el gasto. Intenta nuevamente.`);
        } finally {
            setIsLoading(false);
        }
    };
    
    // 5. Manejador de Eliminación de Gasto
    const handleDeleteExpense = async (expenseId) => {
        if (!db || !userId) {
            setError("La aplicación no está lista o el usuario no está autenticado.");
            return;
        }
        
        // **CORRECCIÓN:** Se eliminó la dependencia de window.confirm() para evitar el bloqueo del iframe.

        try {
            const expenseDocPath = `/artifacts/${appId}/users/${userId}/expenses/${expenseId}`;
            await deleteDoc(doc(db, expenseDocPath));
            // Si estábamos editando el gasto que se eliminó, salimos del modo edición.
            if (editingExpenseId === expenseId) {
                handleCancelEdit();
            }
        } catch (e) {
            console.error("Error al eliminar el gasto:", e);
            setError("No se pudo eliminar el gasto. Intenta de nuevo.");
        }
    };


    // 6. Manejador de Reinicio y Archivo de Gastos
    const handleResetAndArchive = async () => {
        if (!db || !userId || expenses.length === 0) return;

        // Implementamos un modal o confirmación simple (simulado)
        if (!window.confirm("¿Estás seguro de que quieres archivar este periodo y reiniciar el contador? ¡Esta acción es irreversible para los gastos actuales!")) {
            return;
        }

        setIsArchiving(true);
        setError(null);
        
        try {
            const currentMonth = new Date().toLocaleString('es-AR', { month: 'long', year: 'numeric' });

            // 1. Obtener la data de resumen del mes actual
            const archiveData = {
                title: `Resumen de Gastos: ${currentMonth}`,
                totalSpent: totalSpent,
                categorySummary: categoryData.map(item => ({
                    category: item.category,
                    total: item.total,
                    percentage: item.percentage
                })),
                archiveDate: Timestamp.now(),
                totalExpensesCount: expenses.length
            };

            // 2. Guardar el resumen en la colección de historial
            const historyCollectionPath = `/artifacts/${appId}/users/${userId}/history`;
            await addDoc(collection(db, historyCollectionPath), archiveData);
            console.log("Resumen archivado con éxito.");

            // 3. Eliminar todos los gastos de la colección actual (gastos)
            const expensesCollectionPath = `/artifacts/${appId}/users/${userId}/expenses`;
            const q = query(collection(db, expensesCollectionPath));
            const snapshot = await getDocs(q);
            
            // Usamos Promise.all para eliminar documentos en paralelo
            const deletePromises = snapshot.docs.map(doc => deleteDoc(doc.ref));
            await Promise.all(deletePromises);
            
            console.log(`Eliminados ${deletePromises.length} gastos del mes actual.`);
            
        } catch (e) {
            console.error("Error al archivar/reiniciar los gastos:", e);
            setError("Error al archivar/reiniciar. Consulta la consola para más detalles.");
        } finally {
            setIsArchiving(false);
        }
    };

    // 7. Formato de moneda para mostrar los gastos
    const currencyFormatter = useMemo(() => new Intl.NumberFormat('es-AR', {
        style: 'currency',
        currency: 'ARS', // Pesos Argentinos (ARS)
        minimumFractionDigits: 2,
    }), []);

    // 8. Cálculo del total mensual y datos para el gráfico
    const { totalSpent, categoryData } = useMemo(() => {
        const total = expenses.reduce((sum, expense) => sum + expense.amount, 0);

        const totals = expenses.reduce((acc, expense) => {
            const category = expense.category || 'No Categorizado';
            acc[category] = (acc[category] || 0) + expense.amount;
            return acc;
        }, {});

        const data = Object.keys(totals).map(category => ({
            category,
            total: totals[category],
            // Calcular porcentaje para la visualización
            percentage: total > 0 ? (totals[category] / total) * 100 : 0
        }));
        
        // Ordenar de mayor a menor gasto
        data.sort((a, b) => b.total - a.total);

        return { totalSpent: total, categoryData: data };
    }, [expenses]);
    
    // Componente de Visualización de Distribución (Gráfico de Barras Simple)
    const CategoryBarChart = () => (
        <div className="bg-white p-6 rounded-xl shadow-md transition duration-300 hover:shadow-lg">
            <h2 className="text-xl font-semibold mb-4 text-gray-800 flex items-center">
                <BarChart4 className="w-5 h-5 mr-2 text-indigo-600" />
                Distribución de Gastos Actual
            </h2>
            
            {categoryData.length === 0 ? (
                 <p className="text-center text-gray-500 py-4">Añade gastos para ver la distribución.</p>
            ) : (
                <div className="space-y-4">
                    {categoryData.map((item, index) => (
                        <div key={item.category} className="transition-all duration-500 ease-out" style={{ animationDelay: `${index * 0.1}s` }}>
                            <div className="flex justify-between items-center mb-1 text-sm">
                                <span className="font-medium text-gray-700">{item.category}</span>
                                <span className="font-bold text-gray-900">{currencyFormatter.format(item.total)}</span>
                            </div>
                            <div className="w-full bg-gray-200 rounded-full h-2.5">
                                <div 
                                    className={`${CATEGORY_COLORS[item.category] || CATEGORY_COLORS['Otros']} h-2.5 rounded-full transition-all duration-700 ease-out`} 
                                    style={{ width: `${item.percentage}%` }}
                                    title={`${item.percentage.toFixed(1)}%`}
                                ></div>
                            </div>
                            <p className="text-xs text-gray-500 mt-1">{item.percentage.toFixed(1)}% del total</p>
                        </div>
                    ))}
                </div>
            )}
        </div>
    );

    // Componente para ver el historial
    const HistoryViewer = () => (
        <div className="bg-white p-6 rounded-xl shadow-md transition duration-300 hover:shadow-lg">
            <h2 className="text-xl font-semibold mb-4 text-gray-800 flex items-center">
                <Archive className="w-5 h-5 mr-2 text-pink-600" />
                Historial Archivado ({history.length})
            </h2>
            {history.length === 0 ? (
                <p className="text-center text-gray-500 py-4">El historial estará disponible después del primer reinicio.</p>
            ) : (
                <div className="space-y-4 max-h-96 overflow-y-auto pr-2">
                    {history.map((record) => (
                        <div key={record.id} className="p-3 bg-gray-50 rounded-lg border border-gray-200">
                            <p className="font-bold text-indigo-700 text-lg">{record.title}</p>
                            <div className="flex justify-between items-center mt-1 text-sm">
                                <span className="text-gray-600">Total Gastado:</span>
                                <span className="font-extrabold text-red-600">{currencyFormatter.format(record.totalSpent)}</span>
                            </div>
                            <div className="flex justify-between items-center text-xs mt-1 text-gray-500">
                                <span>Gastos Registrados:</span>
                                <span>{record.totalExpensesCount}</span>
                            </div>
                            <p className="text-xs text-gray-400 mt-1">Archivado: {record.archiveDate.toLocaleDateString('es-AR')}</p>
                            
                            {/* Opcionalmente mostrar detalle de categorías archivadas */}
                            {record.categorySummary && (
                                <details className="mt-2 text-xs">
                                    <summary className="cursor-pointer font-medium text-indigo-500 hover:text-indigo-600">Ver Detalle por Categoría</summary>
                                    <ul className="list-disc list-inside mt-1 ml-2 space-y-0.5">
                                        {record.categorySummary.map((cat, i) => (
                                            <li key={i} className="text-gray-600 flex justify-between">
                                                <span>{cat.category}:</span>
                                                <span className="font-mono ml-2">
                                                    {currencyFormatter.format(cat.total)} ({cat.percentage.toFixed(1)}%)
                                                </span>
                                            </li>
                                        ))}
                                    </ul>
                                </details>
                            )}
                        </div>
                    ))}
                </div>
            )}
        </div>
    );


    // Diseño y estructura (Tailwind CSS para elegancia y responsividad)
    return (
        <div className="min-h-screen bg-gray-50 p-4 sm:p-8 font-['Inter']">
            <script src="https://cdn.tailwindcss.com"></script>
            <style>{`
                @import url('https://fonts.googleapis.com/css2?family=Inter:wght@300;400;600;700&display=swap');
                /* Animación de entrada sutil para los ítems */
                @keyframes fadeIn {
                    from { opacity: 0; transform: translateY(10px); }
                    to { opacity: 1; transform: translateY(0); }
                }
                .expense-item {
                    animation: fadeIn 0.5s ease-out forwards;
                }
            `}</style>

            <header className="mb-8 text-center">
                <h1 className="text-4xl font-extrabold text-indigo-700 flex items-center justify-center">
                    <Zap className="w-8 h-8 mr-2 text-yellow-500 animate-pulse" />
                    Gastos Inteligentes
                </h1>
                <p className="text-gray-500 mt-2">Registra y clasifica tus gastos automáticamente.</p>
                {userId && (
                    <div className="mt-4 text-xs text-gray-400 flex items-center justify-center">
                        <User className="w-3 h-3 mr-1" />
                        ID de Usuario: {userId}
                    </div>
                )}
            </header>
            
            {/* Indicador de Carga Global */}
            {!isAuthReady && (
                <div className="flex flex-col items-center justify-center h-[70vh] text-indigo-500">
                    <Loader2 className="w-10 h-10 animate-spin mb-4" />
                    <p className="text-lg font-medium">Conectando con la base de datos...</p>
                    <p className="text-sm text-gray-400 mt-2">Espera un momento, por favor.</p>
                </div>
            )}
            

            {/* Main Content solo se renderiza si la autenticación está lista */}
            {isAuthReady && (
                <main className="max-w-4xl mx-auto grid grid-cols-1 lg:grid-cols-3 gap-8">
                    {/* Columna de Registro de Gasto (Input) */}
                    <div className="lg:col-span-1 bg-white p-6 rounded-xl shadow-2xl h-fit sticky top-4 transition duration-300 hover:shadow-indigo-300/50">
                        <h2 className="text-2xl font-semibold mb-6 text-gray-800">
                            {isEditing ? 'Editar Gasto Existente' : 'Añadir Nuevo Gasto'}
                        </h2>

                        <form onSubmit={handleSubmit} className="space-y-5">
                            {/* Campo de Monto */}
                            <div className="relative">
                                <label htmlFor="amount" className="text-sm font-medium text-gray-700 block mb-1">Monto (ARS)</label>
                                <div className="flex items-center border border-gray-300 rounded-lg focus-within:ring-2 focus-within:ring-indigo-500 transition duration-150">
                                    <DollarSign className="w-5 h-5 ml-3 text-gray-400" />
                                    <input
                                        id="amount"
                                        type="number"
                                        step="0.01"
                                        placeholder="0.00"
                                        value={amount}
                                        onChange={(e) => setAmount(e.target.value)}
                                        className="w-full p-3 pl-2 pr-4 text-lg bg-transparent focus:outline-none rounded-r-lg"
                                        required
                                        disabled={isLoading}
                                    />
                                </div>
                            </div>

                            {/* Campo de Descripción */}
                            <div className="relative">
                                <label htmlFor="description" className="text-sm font-medium text-gray-700 block mb-1">Descripción</label>
                                <div className="flex items-center border border-gray-300 rounded-lg focus-within:ring-2 focus-within:ring-indigo-500 transition duration-150">
                                    <Tag className="w-5 h-5 ml-3 text-gray-400" />
                                    <input
                                        id="description"
                                        type="text"
                                        placeholder="Ej: Cena en restaurante con amigos"
                                        value={description}
                                        onChange={(e) => setDescription(e.target.value)}
                                        className="w-full p-3 pl-2 pr-4 text-lg bg-transparent focus:outline-none rounded-r-lg"
                                        required
                                        disabled={isLoading}
                                    />
                                </div>
                            </div>

                            {/* Mensaje de Error */}
                            {error && (
                                <div className="p-3 bg-red-100 text-red-600 border border-red-300 rounded-lg text-sm transition duration-300 ease-in-out">
                                    {error}
                                </div>
                            )}

                            {/* Botón de Envío */}
                            <button
                                type="submit"
                                className={`w-full flex items-center justify-center py-3 px-4 text-white font-bold text-lg rounded-xl shadow-lg transition duration-300 transform hover:scale-[1.01] disabled:cursor-not-allowed ${
                                    isEditing ? 'bg-green-600 hover:bg-green-700 disabled:bg-green-400' : 'bg-indigo-600 hover:bg-indigo-700 disabled:bg-indigo-400'
                                }`}
                                disabled={isLoading || isArchiving}
                            >
                                {isLoading ? (
                                    <>
                                        <Loader2 className="w-5 h-5 mr-2 animate-spin" />
                                        {isEditing ? 'Guardando...' : 'Clasificando...'}
                                    </>
                                ) : (
                                    <>
                                        <Send className="w-5 h-5 mr-2" />
                                        {isEditing ? 'Guardar Cambios' : 'Añadir Gasto'}
                                    </>
                                )}
                            </button>
                            
                            {/* Botón de Cancelar Edición */}
                            {isEditing && (
                                <button
                                    type="button"
                                    onClick={handleCancelEdit}
                                    className="w-full flex items-center justify-center py-2 px-4 bg-gray-300 text-gray-800 font-bold rounded-xl shadow-md hover:bg-gray-400 transition duration-300"
                                    disabled={isLoading}
                                >
                                    <XCircle className="w-5 h-5 mr-2" />
                                    Cancelar Edición
                                </button>
                            )}

                            <p className="text-xs text-center text-gray-400 pt-2">
                                *La Categoría y Clasificación se generan automáticamente con IA.
                            </p>
                        </form>
                    </div>

                    {/* Columna de Resumen, Gráfico y Lista de Gastos */}
                    <div className="lg:col-span-2 space-y-6">
                        {/* Resumen Total y Botón de Reinicio */}
                        <div className="bg-indigo-100 p-5 rounded-xl shadow-md flex justify-between items-center transition duration-300 transform hover:scale-[1.005]">
                            <div>
                                <p className="text-sm font-medium text-indigo-700">Gasto Total Actual</p>
                                <p className="text-3xl font-bold text-indigo-900 mt-1">{currencyFormatter.format(totalSpent)}</p>
                            </div>

                            {expenses.length > 0 && (
                                <button
                                    onClick={handleResetAndArchive}
                                    className="flex items-center px-4 py-2 bg-pink-600 text-white font-semibold rounded-lg shadow-md hover:bg-pink-700 transition duration-300 disabled:bg-pink-400"
                                    disabled={isArchiving || isLoading || isEditing}
                                >
                                    {isArchiving ? (
                                        <Loader2 className="w-5 h-5 mr-2 animate-spin" />
                                    ) : (
                                        <RotateCcw className="w-5 h-5 mr-2" />
                                    )}
                                    {isArchiving ? 'Archivando...' : 'Archivar y Reiniciar'}
                                </button>
                            )}
                        </div>
                        
                        {/* GRÁFICO DE DISTRIBUCIÓN */}
                        <CategoryBarChart />

                        {/* Visualizador de Historial */}
                        <HistoryViewer />

                        {/* Historial de Gastos Actuales */}
                        <h2 className="text-2xl font-semibold mb-4 text-gray-800">Gastos del Período Actual ({expenses.length})</h2>

                        {/* Lista de Gastos */}
                        <div className="space-y-3">
                            {expenses.length === 0 && (
                                 <div className="p-5 text-center text-gray-500 bg-white rounded-xl shadow-inner">
                                    {isAuthReady ? '¡Aún no tienes gastos! Añade el primero arriba.' : 'Cargando historial...'}
                                </div>
                            )}
                            {expenses.map((expense, index) => (
                                <div
                                    key={expense.id}
                                    className="expense-item flex items-center justify-between p-4 bg-white rounded-lg shadow-sm border-l-4 border-indigo-500 transition duration-300 hover:shadow-lg"
                                    style={{ animationDelay: `${index * 0.05}s` }}
                                >
                                    {/* Contenido del gasto (Monto, Descripción, Categoría) */}
                                    <div className="flex-1 min-w-0">
                                        {/* Monto y Descripción */}
                                        <p className="text-xl font-bold text-gray-900 truncate">
                                            {currencyFormatter.format(expense.amount)}
                                        </p>
                                        <p className="text-sm text-gray-600 truncate mt-0.5" title={expense.description}>
                                            {expense.description}
                                        </p>
                                    </div>

                                    <div className="text-right ml-4 space-y-1 flex items-center">
                                        
                                        {/* Botón de Editar */}
                                        <button 
                                            onClick={() => handleEditClick(expense)}
                                            className="p-1 text-indigo-400 hover:text-indigo-600 transition duration-150 rounded-full hover:bg-indigo-50 focus:outline-none focus:ring-2 focus:ring-indigo-500 mr-1"
                                            title="Editar Gasto"
                                            disabled={isLoading || isEditing}
                                        >
                                            <SquarePen className="w-5 h-5" />
                                        </button>

                                        {/* Botón de Eliminar */}
                                        <button 
                                            onClick={() => handleDeleteExpense(expense.id)}
                                            className="p-1 text-red-400 hover:text-red-600 transition duration-150 rounded-full hover:bg-red-50 focus:outline-none focus:ring-2 focus:ring-red-500 mr-3"
                                            title="Eliminar Gasto"
                                            disabled={isLoading || isArchiving} 
                                        >
                                            <XCircle className="w-5 h-5" />
                                        </button>

                                        {/* Metadatos (Categoría y Fecha) */}
                                        <div>
                                            <div className="flex items-center justify-end text-xs font-semibold text-indigo-600 bg-indigo-100 px-2 py-0.5 rounded-full">
                                                <Tag className="w-3 h-3 mr-1" />
                                                {expense.category}
                                            </div>
                                            <div className="text-xs text-gray-500 mt-1">
                                                {expense.classification}
                                            </div>
                                            <div className="flex items-center justify-end text-xs text-gray-400 mt-1">
                                                <Calendar className="w-3 h-3 mr-1" />
                                                {expense.date.toLocaleDateString('es-AR')}
                                            </div>
                                        </div>
                                    </div>
                                </div>
                            ))}
                        </div>
                    </div>
                </main>
            )}
        </div>
    );
};

export default App;
