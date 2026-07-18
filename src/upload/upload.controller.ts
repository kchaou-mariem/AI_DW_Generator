// import { Controller, Post, UseInterceptors, UploadedFiles, BadRequestException } from '@nestjs/common';
// import { FilesInterceptor } from '@nestjs/platform-express';
// import { UploadService } from './upload.service';

// const ALLOWED_EXTENSIONS = ['csv', 'xlsx', 'xls', 'txt'];

// @Controller('upload')
// export class UploadController {
//   constructor(private readonly uploadService: UploadService) {}

//   @Post()
//   @UseInterceptors(FilesInterceptor('files', 10))
//   async uploadFiles(@UploadedFiles() files: Express.Multer.File[]) {
//     if (!files || files.length === 0) {
//       throw new BadRequestException('Aucun fichier reçu');
//     }

//     for (const file of files) {
//       this.validateFile(file);
//     }

//     const results: any[] = [];
//     for (const file of files) {
//       const result = await this.uploadService.processFile(file);
//       results.push(result);
//     }
//     return results;
//   }

//   private validateFile(file: Express.Multer.File) {
//     const extension = file.originalname.split('.').pop()?.toLowerCase();
//     if (!extension || !ALLOWED_EXTENSIONS.includes(extension)) {
//       throw new BadRequestException(
//         `Format non supporté: .${extension}. Formats acceptés: ${ALLOWED_EXTENSIONS.join(', ')}`,
//       );
//     }
//     if (file.size === 0) {
//       throw new BadRequestException(`Le fichier ${file.originalname} est vide`);
//     }
//   }
// }

import { Controller, Post, UseInterceptors, UploadedFiles, BadRequestException } from '@nestjs/common';
import { FilesInterceptor } from '@nestjs/platform-express';
import { UploadService } from './upload.service';

const ALLOWED_EXTENSIONS = ['csv', 'xlsx', 'xls', 'txt'];

@Controller('upload')
export class UploadController {
  constructor(private readonly uploadService: UploadService) {}

  @Post()
  @UseInterceptors(FilesInterceptor('files', 10))
  async uploadFiles(@UploadedFiles() files: Express.Multer.File[]) {
    if (!files || files.length === 0) {
      throw new BadRequestException('Aucun fichier reçu');
    }

    const results: any[] = [];

    for (const file of files) {
      try {
        this.validateFile(file);
        const result = await this.uploadService.processFile(file);
        results.push({ success: true, fileName: file.originalname, ...result });
      } catch (err) {
        results.push({ success: false, fileName: file.originalname, error: err.message });
      }
    }

    return results;
  }

  private validateFile(file: Express.Multer.File) {
    const extension = file.originalname.split('.').pop()?.toLowerCase();
    if (!extension || !ALLOWED_EXTENSIONS.includes(extension)) {
      throw new BadRequestException(
        `Format non supporté: .${extension}. Formats acceptés: ${ALLOWED_EXTENSIONS.join(', ')}`,
      );
    }
    if (file.size === 0) {
      throw new BadRequestException(`Le fichier ${file.originalname} est vide`);
    }
  }
}