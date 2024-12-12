import { router, authProcedure, demoAuthMiddleware, publicProcedure } from '../trpc';
import { z } from 'zod';
import { prisma } from '../prisma';
import { Prisma } from '@prisma/client';
import { helper, TagTreeNode } from '@/lib/helper';
import { _ } from '@/lib/lodash';
import { NoteType } from '../types';
import { attachmentsSchema, notesSchema, tagSchema, tagsToNoteSchema } from '@/lib/prismaZodType';
import { getGlobalConfig } from './config';
import { FileService } from '../plugins/files';
import { AiService } from '../plugins/ai';
import { SendWebhook } from './helper';

const extractHashtags = (input: string): string[] => {
  const withoutCodeBlocks = input.replace(/```[\s\S]*?```/g, '');
  const hashtagRegex = /(?<!:\/\/)(?<=\s|^)#[^\s#]+(?=\s|$)/g;
  const matches = withoutCodeBlocks.match(hashtagRegex);
  return matches ? matches : [];
}

export const noteRouter = router({
  list: authProcedure
    .meta({ openapi: { method: 'POST', path: '/v1/note/list', summary: 'Query notes list', protect: true, tags: ['Note'] } })
    .input(z.object({
      tagId: z.union([z.number(), z.null()]).default(null),
      page: z.number().default(1),
      size: z.number().default(30),
      orderBy: z.enum(["asc", 'desc']).default('desc'),
      type: z.union([z.nativeEnum(NoteType), z.literal(-1)]).default(-1),
      isArchived: z.boolean().default(false).optional(),
      isRecycle: z.boolean().default(false).optional(),
      searchText: z.string().default('').optional(),
      withoutTag: z.boolean().default(false).optional(),
      withFile: z.boolean().default(false).optional(),
      withLink: z.boolean().default(false).optional(),
      isUseAiQuery: z.boolean().default(false).optional(),
    }))
    .output(z.array(notesSchema.merge(
      z.object({
        attachments: z.array(attachmentsSchema),
        tags: z.array(tagsToNoteSchema.merge(
          z.object({
            tag: tagSchema
          }))
        ),
        references: z.array(z.object({ toNoteId: z.number() })).optional(),
        referencedBy: z.array(z.object({ fromNoteId: z.number() })).optional()
      }))
    ))
    .mutation(async function ({ input, ctx }) {
      const { tagId, type, isArchived, isRecycle, searchText, page, size, orderBy, withFile, withoutTag, withLink, isUseAiQuery } = input
      if (isUseAiQuery && searchText?.trim() != '') {
        if (page == 1) {
          return await AiService.enhanceQuery({ query: searchText!, ctx })
        } else {
          return []
        }
      }
      let where: Prisma.notesWhereInput = {
        accountId: Number(ctx.id)
      }

      if (searchText != '') {
        where = {
          ...where,
          OR: [
            { content: { contains: searchText, mode: 'insensitive' } },
            { attachments: { some: { path: { contains: searchText, mode: 'insensitive' } } } }
          ]
        }
      } else {
        where.isRecycle = isRecycle
        if (!isRecycle) {
          where.isArchived = isArchived
        }
        if (type != -1) {
          where.type = type
        }
      }

      if (tagId) {
        const tags = await prisma.tagsToNote.findMany({ where: { tagId } })
        where.id = { in: tags?.map(i => i.noteId) }
      }
      if (withFile) {
        where.attachments = { some: {} }
      }
      if (withoutTag) {
        where.tags = { none: {} }
      }
      if (withLink) {
        where.OR = [
          { content: { contains: 'http://', mode: 'insensitive' } },
          { content: { contains: 'https://', mode: 'insensitive' } }
        ];
      }
      const config = await getGlobalConfig({ ctx })
      let timeOrderBy = config?.isOrderByCreateTime ? { createdAt: orderBy } : { updatedAt: orderBy }
      return await prisma.notes.findMany({
        where,
        orderBy: [{ isTop: "desc" }, timeOrderBy],
        skip: (page - 1) * size,
        take: size,
        include: {
          tags: { include: { tag: true } },
          attachments: true,
          references: {
            select: {
              toNoteId: true
            }
          },
          referencedBy: {
            select: {
              fromNoteId: true
            }
          }
        }
      })
    }),
  publicList: publicProcedure
    .meta({ openapi: { method: 'POST', path: '/v1/note/public-list', summary: 'Query share notes list', tags: ['Note'] } })
    .input(z.object({
      page: z.number().optional().default(1),
      size: z.number().optional().default(30)
    }))
    .output(z.array(notesSchema.merge(
      z.object({
        attachments: z.array(attachmentsSchema)
      }))
    ))
    .mutation(async function ({ input }) {
      const { page, size } = input
      return await prisma.notes.findMany({
        where: { isShare: true },
        orderBy: [{ isTop: "desc" }, { updatedAt: 'desc' }],
        skip: (page - 1) * size,
        take: size,
        include: { tags: true, attachments: true },
      })
    }),
  listByIds: authProcedure
    .meta({ openapi: { method: 'POST', path: '/v1/note/list-by-ids', summary: 'Query notes list by ids', protect: true, tags: ['Note'] } })
    .input(z.object({ ids: z.array(z.number()) }))
    .output(z.array(notesSchema.merge(
      z.object({
        attachments: z.array(attachmentsSchema),
        tags: z.array(tagsToNoteSchema.merge(
          z.object({
            tag: tagSchema
          }))
        ),
        references: z.array(z.object({ toNoteId: z.number() })).optional(),
        referencedBy: z.array(z.object({ fromNoteId: z.number() })).optional()
      }))
    ))
    .mutation(async function ({ input, ctx }) {
      const { ids } = input
      return await prisma.notes.findMany({
        where: { id: { in: ids }, accountId: Number(ctx.id) },
        include: {
          tags: { include: { tag: true } },
          attachments: true,
          references: {
            select: {
              toNoteId: true
            }
          },
          referencedBy: {
            select: {
              fromNoteId: true
            }
          }
        }
      })
    }),
  publicDetail: publicProcedure
    .meta({ openapi: { method: 'POST', path: '/v1/note/public-detail', summary: 'Query share note detail', tags: ['Note'] } })
    .input(z.object({
      id: z.number(),
    }))
    .output(z.union([z.null(), notesSchema.merge(
      z.object({
        attachments: z.array(attachmentsSchema)
      }))]))
    .mutation(async function ({ input }) {
      const { id } = input
      return await prisma.notes.findFirst({ where: { id, isShare: true }, include: { tags: true, attachments: true }, })
    }),
  detail: authProcedure
    .meta({ openapi: { method: 'POST', path: '/v1/note/detail', summary: 'Query note detail', protect: true, tags: ['Note'] } })
    .input(z.object({
      id: z.number(),
    }))
    .output(z.union([z.null(), notesSchema.merge(
      z.object({
        attachments: z.array(attachmentsSchema)
      }))]))
    .mutation(async function ({ input, ctx }) {
      const { id } = input
      return await prisma.notes.findFirst({ where: { id, accountId: Number(ctx.id) }, include: { tags: true, attachments: true }, })
    }),
  dailyReviewNoteList: authProcedure
    .meta({ openapi: { method: 'GET', path: '/v1/note/daily-review-list', summary: 'Query daily review note list', protect: true, tags: ['Note'] } })
    .input(z.void())
    .output(z.array(notesSchema.merge(
      z.object({
        attachments: z.array(attachmentsSchema)
      }))
    ))
    .query(async function ({ ctx }) {
      return await prisma.notes.findMany({
        where: { createdAt: { gt: new Date(new Date().getTime() - 24 * 60 * 60 * 1000) }, isReviewed: false, isArchived: false, accountId: Number(ctx.id) },
        orderBy: { id: 'desc' },
        include: { attachments: true }
      })
    }),
  reviewNote: authProcedure
    .meta({ openapi: { method: 'POST', path: '/v1/note/review', summary: 'Review a note', protect: true, tags: ['Note'] } })
    .input(z.object({ id: z.number() }))
    .output(z.union([z.null(), notesSchema]))
    .mutation(async function ({ input, ctx }) {
      return await prisma.notes.update({ where: { id: input.id, accountId: Number(ctx.id) }, data: { isReviewed: true } })
    }),
  upsert: authProcedure
    .meta({ openapi: { method: 'POST', path: '/v1/note/upsert', summary: 'Update or create note', protect: true, tags: ['Note'] } })
    .input(z.object({
      content: z.union([z.string(), z.null()]).default(null),
      type: z.union([z.nativeEnum(NoteType), z.literal(-1)]).default(0),
      attachments: z.custom<Pick<Prisma.attachmentsCreateInput, 'name' | 'path' | 'size'>[]>().default([]),
      id: z.number().optional(),
      isArchived: z.union([z.boolean(), z.null()]).default(null),
      isTop: z.union([z.boolean(), z.null()]).default(null),
      isShare: z.union([z.boolean(), z.null()]).default(null),
      isRecycle: z.union([z.boolean(), z.null()]).default(null),
      references: z.array(z.number()).optional()
    }))
    .output(z.any())
    .mutation(async function ({ input, ctx }) {
      let { id, isArchived, isRecycle, type, attachments, content, isTop, isShare, references } = input
      if (content != null) {
        content = content?.replace(/&#x20;/g, ' ')?.replace(/&#x20;\\/g, '')?.replace(/\\([#<>{}[\]|`*-_.])/g, '$1');
      }
      const tagTree = helper.buildHashTagTreeFromHashString(extractHashtags(content?.replace(/\\/g, '') + ' '))
      let newTags: Prisma.tagCreateManyInput[] = []
      const handleAddTags = async (tagTree: TagTreeNode[], parentTag: Prisma.tagCreateManyInput | undefined, noteId?: number) => {
        for (const i of tagTree) {
          let hasTag = await prisma.tag.findFirst({ where: { name: i.name, parent: parentTag?.id ?? 0, accountId: Number(ctx.id) } })
          if (!hasTag) {
            hasTag = await prisma.tag.create({ data: { name: i.name, parent: parentTag?.id ?? 0, accountId: Number(ctx.id) } })
          }
          if (noteId) {
            const hasRelation = await prisma.tagsToNote.findFirst({ where: { tag: hasTag, noteId } })
            !hasRelation && await prisma.tagsToNote.create({ data: { tagId: hasTag.id, noteId } })
          }
          if (i?.children) {
            await handleAddTags(i.children, hasTag, noteId);
          }
          newTags.push(hasTag)
        }
      }

      const update: Prisma.notesUpdateInput = {
        ...(type !== -1 && { type }),
        ...(isArchived !== null && { isArchived }),
        ...(isTop !== null && { isTop }),
        ...(isShare !== null && { isShare }),
        ...(isRecycle !== null && { isRecycle }),
        ...(content != null && { content })
      }

      if (id) {
        const note = await prisma.notes.update({ where: { id, accountId: Number(ctx.id) }, data: update })
        if (content == null) return
        const oldTagsInThisNote = await prisma.tagsToNote.findMany({ where: { noteId: note.id }, include: { tag: true } })
        await handleAddTags(tagTree, undefined, note.id)
        const oldTags = oldTagsInThisNote.map(i => i.tag).filter(i => !!i)
        const oldTagsString = oldTags.map(i => `${i?.name}<key>${i?.parent}`)
        const newTagsString = newTags.map(i => `${i?.name}<key>${i?.parent}`)
        const needTobeAddedRelationTags = _.difference(newTagsString, oldTagsString);
        const needToBeDeletedRelationTags = _.difference(oldTagsString, newTagsString);

        // handle references
        const oldReferences = await prisma.noteReference.findMany({ where: { fromNoteId: note.id } });
        const oldReferencesIds = oldReferences.map(ref => ref.toNoteId);
        const needToBeAddedReferences = _.difference(references || [], oldReferencesIds);
        const needToBeDeletedReferences = _.difference(oldReferencesIds, references || []);

        if (needToBeDeletedRelationTags.length != 0) {
          await prisma.tagsToNote.deleteMany({
            where: {
              note: {
                id: note.id
              },
              tag: {
                id: {
                  in: needToBeDeletedRelationTags.map(i => {
                    const [name, parent] = i.split('<key>')
                    return oldTags.find(t => (t?.name == name) && (t?.parent == Number(parent)))!.id
                  }).filter(i => !!i)
                }
              }
            }
          })
        }

        if (needTobeAddedRelationTags.length != 0) {
          for (const relationTag of needTobeAddedRelationTags) {
            const [name, parent] = relationTag.split('<key>');
            const tagId = newTags.find(t => (t.name == name) && (t.parent == Number(parent)))?.id;
            if (tagId) {
              try {
                await prisma.tagsToNote.create({
                  data: { noteId: note.id, tagId }
                });
              } catch (error) {
                if (error.code !== 'P2002') {
                  throw error;
                }
              }
            }
          }
        }

        // add new references
        if (needToBeAddedReferences.length != 0) {
          await prisma.noteReference.createMany({
            data: needToBeAddedReferences.map(toNoteId => ({ fromNoteId: note.id, toNoteId }))
          });
        }

        // references delete old references
        if (needToBeDeletedReferences.length != 0) {
          await prisma.noteReference.deleteMany({
            where: {
              fromNoteId: note.id,
              toNoteId: { in: needToBeDeletedReferences }
            }
          });
        }

        // delete unused tags
        const allTagsIds = oldTags?.map(i => i?.id)
        const usingTags = (await prisma.tagsToNote.findMany({ where: { tagId: { in: allTagsIds } } })).map(i => i.tagId).filter(i => !!i)
        const needTobeDeledTags = _.difference(allTagsIds, usingTags);
        if (needTobeDeledTags) {
          await prisma.tag.deleteMany({ where: { id: { in: needTobeDeledTags }, accountId: Number(ctx.id) } })
        }

        // insert not repeat attachments
        try {
          if (attachments?.length != 0) {
            const oldAttachments = await prisma.attachments.findMany({ where: { noteId: note.id } })
            const needTobeAddedAttachmentsPath = _.difference(attachments?.map(i => i.path), oldAttachments.map(i => i.path));
            if (needTobeAddedAttachmentsPath.length != 0) {
              await prisma.attachments.createMany({
                data: attachments?.filter(t => needTobeAddedAttachmentsPath.includes(t.path))
                  .map(i => { return { noteId: note.id, ...i } })
              })
            }
          }
        } catch (err) {
          console.log(err)
        }
        return note
      } else {
        try {
          const note = await prisma.notes.create({ data: { content: content ?? '', type, accountId: Number(ctx.id), isShare: isShare ? true : false, isTop: isTop ? true : false } })
          await handleAddTags(tagTree, undefined, note.id)
          await prisma.attachments.createMany({
            data: attachments.map(i => { return { noteId: note.id, ...i } })
          })

          //add references
          if (references && references.length > 0) {
            await prisma.noteReference.createMany({
              data: references.map(toNoteId => ({ fromNoteId: note.id, toNoteId }))
            });
          }

          SendWebhook({ ...note, attachments }, 'create', ctx)
          return note
        } catch (error) {
          console.log(error)
        }
      }
    }),
  updateMany: authProcedure
    .meta({ openapi: { method: 'POST', path: '/v1/note/batch-update', summary: 'Batch update note', protect: true, tags: ['Note'] } })
    .input(z.object({
      type: z.union([z.nativeEnum(NoteType), z.literal(-1)]).default(-1),
      isArchived: z.union([z.boolean(), z.null()]).default(null),
      isRecycle: z.union([z.boolean(), z.null()]).default(null),
      ids: z.array(z.number())
    }))
    .output(z.any())
    .mutation(async function ({ input, ctx }) {
      const { type, isArchived, isRecycle, ids } = input
      const update: Prisma.notesUpdateInput = {
        ...(type !== -1 && { type }),
        ...(isArchived !== null && { isArchived }),
        ...(isRecycle !== null && { isRecycle }),
      }
      return await prisma.notes.updateMany({ where: { id: { in: ids }, accountId: Number(ctx.id) }, data: update })
    }),
  trashMany: authProcedure
    .meta({ openapi: { method: 'POST', path: '/v1/note/batch-trash', summary: 'Batch trash note', protect: true, tags: ['Note'] } })
    .input(z.object({ ids: z.array(z.number()) }))
    .output(z.any())
    .mutation(async function ({ input, ctx }) {
      const { ids } = input
      return await prisma.notes.updateMany({ where: { id: { in: ids }, accountId: Number(ctx.id) }, data: { isRecycle: true } })
    }),
  deleteMany: authProcedure.use(demoAuthMiddleware)
    .meta({ openapi: { method: 'POST', path: '/v1/note/batch-delete', summary: 'Batch delete note', protect: true, tags: ['Note'] } })
    // .output(z.union([z.null(), notesSchema]))
    .input(z.object({
      ids: z.array(z.number())
    }))
    .output(z.any())
    .mutation(async function ({ input, ctx }) {
      const { ids } = input
      const notes = await prisma.notes.findMany({
        where: { id: { in: ids }, accountId: Number(ctx.id) },
        include: {
          tags: { include: { tag: true } },
          attachments: true,
          references: true,
          referencedBy: true
        }
      })
      const handleDeleteRelation = async () => {
        for (const note of notes) {
          SendWebhook({ ...note }, 'delete', ctx)
          await prisma.tagsToNote.deleteMany({ where: { noteId: note.id } })

          await prisma.noteReference.deleteMany({
            where: {
              OR: [
                { fromNoteId: note.id },
                { toNoteId: note.id }
              ]
            }
          })

          const allTagsInThisNote = note.tags || []
          const oldTags = allTagsInThisNote.map(i => i.tag).filter(i => !!i)
          const allTagsIds = oldTags?.map(i => i?.id)
          const usingTags = (await prisma.tagsToNote.findMany({
            where: { tagId: { in: allTagsIds } },
            include: { tag: true }
          })).map(i => i.tag?.id).filter(i => !!i)
          const needTobeDeledTags = _.difference(allTagsIds, usingTags);
          if (needTobeDeledTags?.length) {
            await prisma.tag.deleteMany({ where: { id: { in: needTobeDeledTags }, accountId: Number(ctx.id) } })
          }

          if (note.attachments?.length) {
            for (const attachment of note.attachments) {
              try {
                await FileService.deleteFile(attachment.path)
              } catch (error) {
                console.log('delete attachment error:', error)
              }
            }
            await prisma.attachments.deleteMany({
              where: { id: { in: note.attachments.map(i => i.id) } }
            })
          }
        }
      }

      await handleDeleteRelation()
      await prisma.notes.deleteMany({ where: { id: { in: ids }, accountId: Number(ctx.id) } })
      return { ok: true }
    }),
  addReference: authProcedure
    .meta({ openapi: { method: 'POST', path: '/v1/note/add-reference', summary: 'Add note reference', protect: true, tags: ['Note'] } })
    .input(z.object({
      fromNoteId: z.number(),
      toNoteId: z.number(),
    }))
    .output(z.any())
    .mutation(async function ({ input, ctx }) {
      return await insertNoteReference({ ...input, accountId: Number(ctx.id) })
    }),
  noteReferenceList: authProcedure
    .meta({ openapi: { method: 'POST', path: '/v1/note/reference-list', summary: 'Query note references', protect: true, tags: ['Note'] } })
    .input(z.object({
      noteId: z.number(),
      type: z.enum(['references', 'referencedBy']).default('references')
    }))
    .output(z.array(notesSchema.merge(
      z.object({
        attachments: z.array(attachmentsSchema),
        referenceCreatedAt: z.date()
      })
    )))
    .mutation(async function ({ input, ctx }) {
      const { noteId, type } = input;

      if (type === 'references') {
        const references = await prisma.noteReference.findMany({
          where: { fromNoteId: noteId },
          include: {
            toNote: {
              include: {
                attachments: true,
                tags: { include: { tag: true } },
                references: {
                  select: { toNoteId: true }
                },
                referencedBy: {
                  select: { fromNoteId: true }
                }
              }
            }
          },
          orderBy: { createdAt: 'desc' }
        });

        return references.map(ref => ({
          ...ref.toNote,
          referenceCreatedAt: ref.createdAt
        }));
      } else {
        const referencedBy = await prisma.noteReference.findMany({
          where: { toNoteId: noteId },
          include: {
            fromNote: {
              include: {
                attachments: true,
                tags: { include: { tag: true } },
                references: {
                  select: { toNoteId: true }
                },
                referencedBy: {
                  select: { fromNoteId: true }
                }
              }
            }
          },
          orderBy: { createdAt: 'desc' }
        });

        return referencedBy.map(ref => ({
          ...ref.fromNote,
          referenceCreatedAt: ref.createdAt
        }));
      }
    }),
})

let insertNoteReference = async ({ fromNoteId, toNoteId, accountId }) => {
  const [fromNote, toNote] = await Promise.all([
    prisma.notes.findUnique({ where: { id: fromNoteId, accountId } }),
    prisma.notes.findUnique({ where: { id: toNoteId, accountId } })
  ]);

  if (!fromNote || !toNote) {
    throw new Error('Note not found');
  }

  return await prisma.noteReference.create({
    data: {
      fromNoteId,
      toNoteId,
    }
  });
}

// let deleteNoteReference = async ({ fromNoteId, toNoteId, accountId }) => {
//   return await prisma.noteReference.deleteMany({ where: { fromNoteId, toNoteId, accountId } })
// }
