import { z } from "zod";
import { router, authProcedure, publicProcedure } from "../trpc";
import { TRPCError } from "@trpc/server";
import { prisma } from '../prisma';
import axios from "axios";
import { followsSchema } from "@/lib/prismaZodType";

export const followsRouter = router({
  // i want to follow a site
  follow: authProcedure
    .meta({
      openapi: {
        method: 'POST',
        path: '/v1/follows/follow',
        summary: 'Follow a user',
        tags: ['Follows']
      }
    })
    .input(z.object({
      siteUrl: z.string(),
      mySiteUrl: z.string(),
    }))
    .output(z.object({
      success: z.boolean(),
      data: z.any()
    }))
    .mutation(async ({ ctx, input }) => {
      return await prisma.$transaction(async (tx) => {
        input.siteUrl = new URL(input.siteUrl).origin;
        input.mySiteUrl = new URL(input.mySiteUrl).origin;
        const followerId = ctx.id;
        const siteInfo = await axios.get(input.siteUrl + '/api/v1/public/site-info', { params: { id: null } });

        // Check if already following
        const existingFollow = await tx.follows.findFirst({
          where: {
            siteUrl: input.siteUrl,
            accountId: Number(followerId),
            followType: "following",
          },
        });

        if (existingFollow) {
          throw new TRPCError({
            code: "CONFLICT",
            message: "Already following this site",
          });
        }

        const result = await tx.follows.create({
          data: {
            followType: "following",
            siteUrl: input.siteUrl,
            siteName: siteInfo.data.name,
            siteAvatar: siteInfo.data.image ? input.siteUrl + siteInfo.data.image : "",
            accountId: Number(followerId),
          },
        });

        const mySiteInfo = await tx.accounts.findUnique({
          where: {
            id: Number(ctx.id),
          },
        });

        await axios.post(input.siteUrl + '/api/v1/follows/follow-from', {
          mySiteAccountId: siteInfo?.data?.id,
          siteUrl: input.mySiteUrl,
          siteName: mySiteInfo?.nickname ?? mySiteInfo?.name,
          siteAvatar: input.mySiteUrl + mySiteInfo?.image,
        });

        return {
          success: true,
          data: result
        };
      });
    }),

  // some site wants to follow me
  followFrom: publicProcedure
    .meta({
      openapi: {
        method: 'POST',
        path: '/v1/follows/follow-from',
        summary: 'Some site wants to follow me',
        tags: ['Follows']
      }
    })
    .input(z.object({
      mySiteAccountId: z.number(),
      siteUrl: z.string(),
      siteName: z.string(),
      siteAvatar: z.string(),
    }))
    .output(z.object({
      success: z.boolean(),
      data: z.any()
    }))
    .mutation(async ({ input }) => {
      return await prisma.$transaction(async (tx) => {
        input.siteUrl = new URL(input.siteUrl).origin;

        const existingFollow = await tx.follows.findFirst({
          where: {
            siteUrl: input.siteUrl,
            followType: "follower",
            accountId: Number(input.mySiteAccountId),
          },
        });

        if (existingFollow) {
          return {
            success: true,
            data: existingFollow
          }
        }

        const result = await tx.follows.create({
          data: {
            siteUrl: input.siteUrl,
            siteName: input.siteName,
            siteAvatar: input.siteAvatar,
            accountId: Number(input.mySiteAccountId),
            followType: "follower",
          },
        });

        return {
          success: true,
          data: result
        };
      });
    }),

  unfollow: authProcedure
    .meta({
      openapi: {
        method: 'POST',
        path: '/v1/follows/unfollow',
        summary: 'Unfollow a user',
        protect: true,
        tags: ['Follows']
      }
    })
    .input(z.object({
      siteUrl: z.string(),
      mySiteUrl: z.string(),
    }))
    .output(z.boolean())
    .mutation(async ({ ctx, input }) => {
      return await prisma.$transaction(async (tx) => {
        input.siteUrl = new URL(input.siteUrl).origin;
        input.mySiteUrl = new URL(input.mySiteUrl).origin;
        const followerId = ctx.id;
        const siteInfo = await axios.get(input.siteUrl + '/api/v1/public/site-info');

        await tx.follows.deleteMany({
          where: {
            siteUrl: input.siteUrl,
            followType: "following",
            accountId: Number(followerId),
          },
        });

        await axios.post(input.siteUrl + '/api/v1/follows/unfollow-from', {
          mySiteAccountId: siteInfo?.data?.id,
          siteUrl: input.mySiteUrl,
        });

        return true
      });
    }),

  unfollowFrom: publicProcedure
    .meta({
      openapi: {
        method: 'POST',
        path: '/v1/follows/unfollow-from',
        summary: 'Some site wants to unfollow me',
        tags: ['Follows']
      }
    })
    .input(z.object({
      siteUrl: z.string(),
      mySiteAccountId: z.number(),
    }))
    .output(z.boolean())
    .mutation(async ({ input }) => {
      return await prisma.$transaction(async (tx) => {
        input.siteUrl = new URL(input.siteUrl).origin;

        const result = await tx.follows.deleteMany({
          where: {
            followType: "follower",
            siteUrl: input.siteUrl,
            accountId: Number(input.mySiteAccountId),
          },
        });

        return true
      });
    }),

  followList: authProcedure
    .meta({
      openapi: {
        method: 'GET',
        path: '/v1/follows/follow-list',
        summary: 'Get following list',
        protect: true,
        tags: ['Follows']
      }
    })
    .input(z.object({
      userId: z.number().nullable().optional()
    }))
    .output(z.array(followsSchema).optional())
    .query(async ({ ctx, input }) => {
      const userId = input.userId ?? Number(ctx.id);

      const result = await prisma.follows.findMany({
        where: {
          accountId: userId,
          followType: "following",
        }
      });

      return result.map(item => ({
        ...item,
        siteName: item.siteName ?? undefined,
        siteAvatar: item.siteAvatar ?? undefined,
        description: item.description ?? undefined,
      }));
    }),

  followerList: authProcedure
    .meta({
      openapi: {
        method: 'GET',
        path: '/v1/follows/followers',
        summary: 'Get followers list',
        protect: true,
        tags: ['Follows']
      }
    })
    .input(z.object({
      userId: z.number().nullable().optional(),
    }))
    .output(z.array(followsSchema).optional())
    .query(async ({ ctx, input }) => {
      const userId = input.userId ?? Number(ctx.id);

      const result = await prisma.follows.findMany({
        where: {
          accountId: userId,
          followType: "follower",
        },
      });

      return result.map(item => ({
        ...item,
        siteName: item.siteName ?? undefined,
        siteAvatar: item.siteAvatar ?? undefined,
        description: item.description ?? undefined,
      }));
    }),

  isFollowing: authProcedure
    .meta({
      openapi: {
        method: 'GET',
        path: '/v1/follows/is-following',
        summary: 'Check if following a user',
        protect: true,
        tags: ['Follows']
      }
    })
    .input(z.object({
      siteUrl: z.string(),
    }))
    .output(z.object({
      success: z.boolean(),
      data: z.boolean()
    }))
    .query(async ({ ctx, input }) => {
      const followerId = ctx.id;

      const follow = await prisma.follows.findFirst({
        where: {
          siteUrl: input.siteUrl,
          accountId: Number(followerId),
        },
        select: {
          id: true,
        },
      });

      return {
        success: true,
        data: !!follow
      };
    }),
});