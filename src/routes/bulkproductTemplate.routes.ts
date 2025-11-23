import { TemplateController } from '../controllers/bulkproductTemplate.controller.ts';
import { Router } from 'express';

const router = Router();
const templateController = new TemplateController();

router.get('/generate/:categoryId', (req, res) => templateController.generateTemplate(req, res));
router.get('/download/:categoryId', (req, res) => templateController.downloadTemplate(req, res));

export default router;