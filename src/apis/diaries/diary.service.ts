import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  LoggerService,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DiaryEntity } from './entities/diary.entity';
import { EntityManager, Repository } from 'typeorm';
import { CreateDiaryDto } from './dto/create-diary.dto';
import { UpdateDiaryDto } from './dto/update-diary.dto';
import { HttpService } from '@nestjs/axios';
import { lastValueFrom } from 'rxjs';
import { DiaryLikeEntity } from './entities/diary-likes.entity';

@Injectable()
export class DiaryService {
  constructor(
    @Inject(Logger)
    private readonly logger: LoggerService,
    @InjectRepository(DiaryEntity)
    private readonly diaryRepository: Repository<DiaryEntity>,
    @InjectRepository(DiaryLikeEntity)
    private readonly diaryLikeRepository: Repository<DiaryLikeEntity>,
    private readonly httpService: HttpService,
  ) {}

  async createDiary(dto: CreateDiaryDto, userId: number, transactionManager: EntityManager) {
    try {
      const newDiary = new DiaryEntity();
      Object.assign(newDiary, { userId, ...dto });
      const diary = await transactionManager.save(newDiary);
      return diary;
    } catch (e) {
      this.logger.error(e);
      throw e;
    }
  }

  async updateDiary(diaryId: number, userId: number, dto: UpdateDiaryDto, transactionManager: EntityManager) {
    try {
      const isSameUser = await this.isSameUser(userId, diaryId);
      if (!isSameUser) {
        throw new ForbiddenException('포스트 수정 권한이 없습니다');
      }
      const result = await transactionManager.update(DiaryEntity, diaryId, { ...dto });
      if (result.affected === 0) {
        throw new BadRequestException('Diary update failed: Nothing updated');
      }
      return;
    } catch (e) {
      this.logger.error(e);
      throw e;
    }
  }

  async deleteDiary(diaryId: number, userId: number, transactionManager: EntityManager) {
    try {
      const isSameUser = await this.isSameUser(userId, diaryId);
      if (!isSameUser) {
        throw new ForbiddenException('포스트 삭제 권한이 없습니다');
      }
      const diary = await this.diaryRepository.findOne({ where: { diaryId } });
      if (!diary) {
        throw new NotFoundException('다이어리가 이미 삭제되었거나 존재하지 않습니다');
      }

      // 다이어리 좋아요 정보 삭제 (만약 있다면)
      await transactionManager.query(`DELETE FROM public."Diary-Like" WHERE "diaryId" = ${diaryId}`);

      // 다이어리 삭제
      const result = await transactionManager.delete(DiaryEntity, { diaryId });
      if (result.affected === 0) {
        throw new BadRequestException('Diary delete failed: Nothing deleted');
      }

      return;
    } catch (e) {
      this.logger.error(e);
      throw e;
    }
  }

  async readDiaryDetail(diaryId: number, token: string) {
    try {
      const diary = await this.diaryRepository.findOne({ where: { diaryId } });
      if (!diary) {
        throw new NotFoundException('존재하지 않는 다이어리 입니다.');
      }
      // 다이어리 작성자 정보 불러오기
      const { userId, ...restData } = diary;
      const accessToken = token;
      const headers = { Authorization: `Bearer ${accessToken}` };
      let apiUrl;
      if (process.env.NODE_ENV === 'dev') {
        apiUrl = `http://${process.env.HOST}:3000/api/user/specificuser/${userId}`;
      } else {
        apiUrl = `http://${process.env.Eureka_HOST}/api/user/specificuser/${userId}`;
      }

      const diaryWriterInfo = await lastValueFrom(this.httpService.get(apiUrl, { headers }));

      return { ...restData, writer: diaryWriterInfo.data.data };
    } catch (e) {
      this.logger.error(e);
      throw e;
    }
  }

  async createDiaryLike(diaryId: number, userId: number, transactionManager: EntityManager) {
    try {
      if (!diaryId || !userId) {
        throw new BadRequestException('요청 값이 올바르지 않습니다');
      }

      // 좋아요를 이미 눌렀을 경우 에러처리
      const likeInfo = await this.diaryLikeRepository.findOne({ where: { diaryId, userId } });
      if (likeInfo) {
        throw new ConflictException('좋아요를 이미 눌렀습니다');
      }

      // 좋아요 클릭 정보 저장
      const newDiaryLike = new DiaryLikeEntity();
      Object.assign(newDiaryLike, { diaryId, userId });
      await transactionManager.save(newDiaryLike);

      // 좋아요 클릭 수 업데이트 (1증가)
      await transactionManager.query(`UPDATE public."Diary" SET "likes" = "likes" + 1 WHERE "diaryId" = ${diaryId}`);

      // 다이어리 정보가 없을 경우 에러 처리
      const diary = await this.diaryRepository.findOne({ where: { diaryId } });
      if (!diary) {
        throw new NotFoundException('다이어리가 삭제되었거나 존재하지 않습니다');
      }

      return;
    } catch (e) {
      this.logger.error(e);
      throw e;
    }
  }

  async deleteDiaryLike(diaryId: number, userId: number, transactionManager: EntityManager) {
    try {
      if (!diaryId || !userId) {
        throw new BadRequestException('요청 값이 올바르지 않습니다');
      }

      const result = await transactionManager.delete(DiaryLikeEntity, { diaryId, userId });

      if (result.affected === 0) {
        throw new ConflictException('좋아요를 이미 취소했거나 다이어리가 존재하지 않습니다');
      }
      await transactionManager.query(`UPDATE public."Diary" SET "likes" = "likes" - 1 WHERE "diaryId" = ${diaryId}`);

      return;
    } catch (e) {
      this.logger.error(e);
      throw e;
    }
  }

  private async isSameUser(currentUserId: number, diaryId: number) {
    const diary = await this.diaryRepository.findOne({ where: { diaryId } });
    const diaryWriterId = diary.userId;
    return currentUserId == diaryWriterId;
  }
}