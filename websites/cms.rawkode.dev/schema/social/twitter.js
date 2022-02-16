import React from "react";
import { TextInput, Stack } from "@sanity/ui";
import { SiTwitter } from "react-icons/si";
import { FormField } from "@sanity/base/components";
import PatchEvent, { set, unset } from "@sanity/form-builder/PatchEvent";
import { useId } from "@reach/auto-id";

export const TwitterHandle = {
  name: "twitter",
  title: "Twitter Handle",
  type: "string",
  inputComponent: React.forwardRef((props, ref) => {
    const {
      type,
      value,
      readOnly,
      placeholder,
      markers,
      presence,
      compareValue,
      onFocus,
      onBlur,
      onChange,
    } = props;

    const inputId = useId();
    const handleChange = React.useCallback(
      (event) => {
        const inputValue = event.currentTarget.value;
        onChange(PatchEvent.from(inputValue ? set(inputValue) : unset()));
      },
      [onChange]
    );

    return (
      <FormField
        description={type.description}
        title={type.title}
        markers={markers}
        presence={presence}
        compareValue={compareValue}
        inputId={inputId}
      >
        <Stack space={2}>
          <TextInput
            id={inputId}
            onFocus={onFocus}
            onBlur={onBlur}
            readOnly={readOnly}
            placeholder={placeholder}
            onChange={handleChange}
            ref={ref}
            value={value}
            icon={SiTwitter}
          />
        </Stack>
      </FormField>
    );
  }),
};
