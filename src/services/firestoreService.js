import { getFirestore, collection, addDoc, getDocs, query, where, serverTimestamp } from "firebase/firestore";
import app from '../firebase';

// Initialize Cloud Firestore and get a reference to the service
const db = getFirestore(app);

const expensesCollectionRef = collection(db, 'expenses');

/**
 * Adds a new expense document to the 'expenses' collection.
 * @param {object} expenseData - The data for the new expense.
 * @param {string} expenseData.userId - The ID of the user who owns the expense.
 * @param {string} expenseData.description - The description of the expense.
 * @param {number} expenseData.amount - The amount of the expense.
 * @param {string} expenseData.category - The category of the expense.
 * @returns {Promise<string>} The ID of the newly created document.
 */
export const addExpense = async (expenseData) => {
  try {
    const docRef = await addDoc(expensesCollectionRef, {
      ...expenseData,
      date: serverTimestamp() // Let Firebase set the creation date
    });
    console.log("Document written with ID: ", docRef.id);
    return docRef.id;
  } catch (e) {
    console.error("Error adding document: ", e);
    throw new Error("Could not add expense.");
  }
};

/**
 * Fetches all expenses for a specific user.
 * @param {string} userId - The ID of the user whose expenses to fetch.
 * @returns {Promise<Array<object>>} An array of expense objects.
 */
export const getExpenses = async (userId) => {
  if (!userId) {
    throw new Error("User ID is required to fetch expenses.");
  }

  try {
    const q = query(expensesCollectionRef, where("userId", "==", userId));
    const querySnapshot = await getDocs(q);
    
    const expenses = [];
    querySnapshot.forEach((doc) => {
      expenses.push({
        id: doc.id, // Include the document ID
        ...doc.data()
      });
    });
    
    return expenses;
  } catch (e) {
    console.error("Error getting documents: ", e);
    throw new Error("Could not fetch expenses.");
  }
};
