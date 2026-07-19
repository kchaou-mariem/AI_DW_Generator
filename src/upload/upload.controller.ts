import {
  Controller,
  Post,
  Get,
  Body,
  Param,
  UseInterceptors,
  UploadedFiles,
  BadRequestException,
} from '@nestjs/common';
import { FilesInterceptor } from '@nestjs/platform-express';
import { UploadService } from './upload.service';

const ALLOWED_EXTENSIONS = ['csv', 'xlsx', 'xls', 'txt'];

@Controller('upload')
export class UploadController {
  constructor(private readonly uploadService: UploadService) {}

  @Post()
  @UseInterceptors(FilesInterceptor('files', 10))
  async uploadFiles(
    @UploadedFiles() files: Express.Multer.File[],
    @Body('database') database: string,
  ) {
    if (!database) {
      throw new BadRequestException('Veuillez préciser une base de données cible');
    }
    if (!files || files.length === 0) {
      throw new BadRequestException('Aucun fichier reçu');
    }

    await this.uploadService.ensureDatabaseExists(database);

    const results: any[] = [];
    for (const file of files) {
      try {
        this.validateFile(file);
        const result = await this.uploadService.processFile(file, database);
        results.push({ success: true, fileName: file.originalname, ...result });
      } catch (err) {
        results.push({ success: false, fileName: file.originalname, error: err.message });
      }
    }

    return { database, files: results };
  }

  @Get('databases')
  async listDatabases() {
    return this.uploadService.listDatabases();
  }

  @Post('databases')
  async createDatabase(@Body('name') name: string) {
    if (!name) {
      throw new BadRequestException('Le nom de la base est requis');
    }
    return this.uploadService.ensureDatabaseExists(name);
  }

  @Get('metadata/:database')
  async getMetadata(@Param('database') database: string) {
    const allMetadata = await this.uploadService.buildMetadataForDatabase(database);
    const relations = this.uploadService.detectCrossTableRelations(allMetadata);
    return { database, tables: allMetadata, crossTableRelations: relations };
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