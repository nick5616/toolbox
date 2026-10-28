import {
  Activity,
  Archive,
  ArrowDownToLine,
  AudioLines,
  Box,
  Captions,
  Check,
  ChevronDown,
  ChevronRight,
  ChevronUp,
  CircleAlert,
  Clipboard,
  Command,
  Copy,
  Cpu,
  Download,
  ExternalLink,
  Eye,
  EyeOff,
  File as FileIcon,
  FileText,
  GripVertical,
  Film,
  Folder,
  FolderOpen,
  History,
  Image as ImageIcon,
  Info,
  LoaderCircle,
  Link as LinkIcon,
  ListFilter,
  Lock,
  MapPin,
  Maximize2,
  MessageSquare,
  Monitor,
  Moon,
  Music,
  PanelLeft,
  Pause,
  Piano,
  Pin,
  PinOff,
  Play,
  RefreshCw,
  Repeat,
  RotateCcw,
  RotateCw,
  ScanSearch,
  Scissors,
  Search,
  Settings,
  Square,
  Sun,
  Trash2,
  TriangleAlert,
  WandSparkles,
  X,
  type LucideIcon,
} from "lucide-react";

/** Static map: only these icons end up in the bundle. */
const icons = {
  download: Download,
  "audio-lines": AudioLines,
  activity: Activity,
  piano: Piano,
  repeat: Repeat,
  "wand-sparkles": WandSparkles,
  "maximize-2": Maximize2,
  "scan-search": ScanSearch,
  captions: Captions,
  "message-square": MessageSquare,
  "file-text": FileText,
  archive: Archive,
  lock: Lock,
  clipboard: Clipboard,
  box: Box,
  settings: Settings,
  history: History,
  "folder-open": FolderOpen,
  folder: Folder,
  x: X,
  "rotate-ccw": RotateCcw,
  "chevron-down": ChevronDown,
  "chevron-up": ChevronUp,
  "chevron-right": ChevronRight,
  copy: Copy,
  "trash-2": Trash2,
  "external-link": ExternalLink,
  search: Search,
  command: Command,
  check: Check,
  "circle-alert": CircleAlert,
  "triangle-alert": TriangleAlert,
  info: Info,
  "loader-circle": LoaderCircle,
  music: Music,
  film: Film,
  image: ImageIcon,
  file: FileIcon,
  link: LinkIcon,
  scissors: Scissors,
  sun: Sun,
  moon: Moon,
  monitor: Monitor,
  "refresh-cw": RefreshCw,
  "panel-left": PanelLeft,
  "list-filter": ListFilter,
  "arrow-down-to-line": ArrowDownToLine,
  square: Square,
  play: Play,
  cpu: Cpu,
  pin: Pin,
  "pin-off": PinOff,
  pause: Pause,
  "map-pin": MapPin,
  "rotate-cw": RotateCw,
  "grip-vertical": GripVertical,
  eye: Eye,
  "eye-off": EyeOff,
} satisfies Record<string, LucideIcon>;

export type IconName = keyof typeof icons;

export const iconNames = Object.keys(icons) as IconName[];

export interface IconProps {
  /** Any string; unknown names fall back to `box`. */
  name: IconName | (string & {});
  size?: number;
  strokeWidth?: number;
  className?: string;
  /** Accessible label. Without it the icon is decorative (aria-hidden). */
  title?: string;
}

export function Icon({ name, size = 16, strokeWidth = 1.75, className, title }: IconProps) {
  const Cmp: LucideIcon = Object.hasOwn(icons, name) ? icons[name as IconName] : Box;
  return (
    <Cmp
      size={size}
      strokeWidth={strokeWidth}
      className={className}
      aria-hidden={title ? undefined : true}
      aria-label={title}
      role={title ? "img" : undefined}
      focusable="false"
    />
  );
}
