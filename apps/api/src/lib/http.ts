import type { FastifyReply, FastifyRequest } from 'fastify';
import type { ZodType } from 'zod';
import { AppError } from './errors.js';

/** 请求体校验：失败抛稳定 VALIDATION_ERROR */
export function parseBody<T>(schema: ZodType<T>, data: unknown): T {
  const result = schema.safeParse(data);
  if (!result.success) {
    const first = result.error.issues[0];
    const where = first?.path?.length ? `（${first.path.join('.')}）` : '';
    throw new AppError('VALIDATION_ERROR', `请求参数无效${where}：${first?.message ?? ''}`);
  }
  return result.data;
}

/** 统一错误响应：{ error: { code, message } }，不泄漏内部细节 */
export function errorHandler(error: unknown, _req: FastifyRequest, reply: FastifyReply): void {
  if (error instanceof AppError) {
    void reply.status(error.statusCode).send({ error: { code: error.code, message: error.message } });
    return;
  }
  // Zod 直接抛出（未经 parseBody）也归一化为 400
  const err = error as { name?: string; issues?: unknown[] };
  if (err?.name === 'ZodError') {
    void reply
      .status(400)
      .send({ error: { code: 'VALIDATION_ERROR', message: '请求参数无效' } });
    return;
  }
  _req.log.error({ err: error }, 'unhandled error');
  void reply.status(500).send({ error: { code: 'INTERNAL', message: '服务器内部错误' } });
}
