import { Route, Routes } from 'react-router-dom';
import Layout from './components/Layout';
import CollectionsPage from './pages/CollectionsPage';
import EmailIntakePage from './pages/EmailIntakePage';
import DashboardPage from './pages/DashboardPage';
import IssuesPage from './pages/IssuesPage';
import JobDetailPage from './pages/JobDetailPage';
import JobsPage from './pages/JobsPage';
import RulesPage from './pages/RulesPage';
import VouchersPage from './pages/VouchersPage';
import BillRecognitionPage from './pages/BillRecognitionPage';
import NotFound from './pages/NotFound/NotFound';

export default function RoutesComponent() {
  return (
    <Routes>
      <Route element={<Layout />}>
        <Route index element={<DashboardPage />} />
        <Route path="jobs" element={<JobsPage />} />
        <Route path="jobs/:id" element={<JobDetailPage />} />
        <Route path="collections" element={<CollectionsPage />} />
        <Route path="email-intake" element={<EmailIntakePage />} />
        <Route path="vouchers" element={<VouchersPage />} />
        <Route path="issues" element={<IssuesPage />} />
        <Route path="rules" element={<RulesPage />} />
        <Route path="bill-recognition" element={<BillRecognitionPage />} />
      </Route>
      <Route path="*" element={<NotFound />} />
    </Routes>
  );
}
