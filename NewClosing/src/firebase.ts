// Import the functions you need from the SDKs you need
import { initializeApp } from "firebase/app";
import { getDatabase } from "firebase/database";

// TODO: Add SDKs for Firebase products that you want to use
// https://firebase.google.com/docs/web/setup#available-libraries

// Your web app's Firebase configuration
const firebaseConfig = {
    apiKey: "AIzaSyAE-bnj4CtyHknuPWLuV6Pplh5h9d4cOA4",
    authDomain: "project-7726471048519015844.firebaseapp.com",
    projectId: "project-7726471048519015844",
    storageBucket: "project-7726471048519015844.appspot.com",
    messagingSenderId: "1023235511605",
    appId: "1:1023235511605:web:08381420e2e1df472d687c",
    databaseURL: "https://closing-1723e-default-rtdb.firebaseio.com" // <-- Add this line
};

// Initialize Firebase
const app = initializeApp(firebaseConfig);
export const db = getDatabase(app);