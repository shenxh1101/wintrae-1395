import { Router, Request, Response } from 'express'
import { prisma } from '../lib/prisma'

const router = Router()

router.get('/member/:memberId', async (req: Request, res: Response) => {
  const memberId = Number(req.params.memberId)
  const packages = await prisma.memberPackage.findMany({
    where: { memberId },
    include: { package: true },
    orderBy: { boughtAt: 'desc' },
  })
  res.json({ data: packages })
})

router.get('/member/:memberId/summary', async (req: Request, res: Response) => {
  const memberId = Number(req.params.memberId)
  const packages = await prisma.memberPackage.findMany({
    where: { memberId },
    include: { package: true },
  })
  const totalRemain = packages.reduce((sum, p) => sum + p.remainSlots, 0)
  const detail = packages.map(p => ({
    id: p.id,
    packageName: p.package.name,
    remainSlots: p.remainSlots,
    totalSlots: p.package.totalSlots,
    expireAt: p.expireAt,
  }))
  res.json({ data: { totalRemain, packages: detail } })
})

router.post('/', async (req: Request, res: Response) => {
  const { memberId, packageId } = req.body
  if (!memberId || !packageId) return res.status(400).json({ error: '缺少必填字段' })

  const pkg = await prisma.coursePackage.findUnique({ where: { id: packageId } })
  if (!pkg) return res.status(404).json({ error: '课程包不存在' })

  const mp = await prisma.memberPackage.create({
    data: { memberId, packageId, remainSlots: pkg.totalSlots },
    include: { package: true },
  })
  res.status(201).json({ data: mp })
})

export default router
