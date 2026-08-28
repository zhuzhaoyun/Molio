/**
 * 发布向导（弹窗壳）—— 现仅作为 PublishForm 的 modal 外壳保留，
 * 供「我的上架」更新模式使用（AccountModal 内无 KB tab 体系）。
 * 首发入口已改为 KB 页内独立 tab（variant="page"，见 KnowledgeBasePage）。
 */
import { PublishForm, type PublishFormProps } from './PublishForm';

export type PublishWizardProps = Omit<PublishFormProps, 'variant' | 'onDirtyChange'>;

export function PublishWizard(props: PublishWizardProps) {
  return <PublishForm variant="modal" {...props} />;
}
