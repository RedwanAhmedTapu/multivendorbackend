// ==================== routes/faq.routes.ts ====================
import { Router } from 'express';
import { FaqController } from '../controllers/faq.controller.ts';

const router = Router();
const faqController = new FaqController();

// Get all FAQs (with filtering and pagination)
router.get('/', (req, res) => faqController.getAllFaqs(req, res));

// Get all categories
router.get('/categories', (req, res) => faqController.getCategories(req, res));

// Get FAQ by ID
router.get('/:id', (req, res) => faqController.getFaqById(req, res));

// Get FAQs by category
router.get('/category/:category', (req, res) => faqController.getFaqsByCategory(req, res));

// Create FAQ
router.post('/', (req, res) => faqController.createFaq(req, res));

// Update FAQ
router.put('/:id', (req, res) => faqController.updateFaq(req, res));

// Delete FAQ
router.delete('/:id', (req, res) => faqController.deleteFaq(req, res));

// Bulk update order
router.patch('/order/bulk', (req, res) => faqController.updateFaqOrder(req, res));

// Toggle FAQ status
router.patch('/:id/toggle-status', (req, res) => faqController.toggleFaqStatus(req, res));

export default router;