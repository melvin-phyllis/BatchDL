import * as SliderPrimitive from "@radix-ui/react-slider";
import { cn } from "@/lib/utils";

interface SliderProps {
  value: number;
  min?: number;
  max?: number;
  step?: number;
  onChange: (value: number) => void;
}

export const Slider = ({ value, min = 1, max = 10, step = 1, onChange }: SliderProps) => (
  <SliderPrimitive.Root
    className="relative flex h-6 w-full touch-none select-none items-center"
    value={[value]}
    min={min}
    max={max}
    step={step}
    onValueChange={(values) => onChange(values[0] ?? value)}
  >
    <SliderPrimitive.Track className="relative h-2 grow overflow-hidden rounded-full bg-zinc-800">
      <SliderPrimitive.Range className="absolute h-full bg-primary" />
    </SliderPrimitive.Track>
    <SliderPrimitive.Thumb
      className={cn(
        "block h-4 w-4 rounded-full border border-zinc-400 bg-white shadow transition-colors",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
      )}
    />
  </SliderPrimitive.Root>
);
