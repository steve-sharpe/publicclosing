import React from 'react';
import ReactDOM from 'react-dom/client';
import ClosingsTVDashboard from './ClosingsTVDashboard';
import './index.css';
import { BrowserRouter as Router, Route, Routes } from 'react-router-dom';

const App = () => {
  const handleJobClick = (jobId) => {
    // Handle job click logic here
    console.log('Job clicked:', jobId);
  };

  return (
    <Router>
      <Routes>
        <Route path="/" element={<ClosingsTVDashboard onJobClick={handleJobClick} />} />
      </Routes>
    </Router>
  );
};

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
