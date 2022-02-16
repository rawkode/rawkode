import S from "@sanity/desk-tool/structure-builder";

const contentMenuItems = S.documentTypeListItems().map((type) => type.getId());

const grouping = [
  {
    name: "crm",
    types: ["person"],
  },
  {
    name: "blog",
    types: ["article"],
  },
  {
    name: "live-stream",
    types: ["show", "episode"],
  },
  {
    name: "meta",
    types: ["category", "series", "technology"],
  },
];

export default () =>
  S.list()
    .title("Content Types")
    .items(
      grouping.map((group) =>
        S.listItem()
          .id(group.name)
          .title(group.name)
          .child(
            S.list()
              .id(group.name)
              .items(
                contentMenuItems
                  .filter((type) => group.types.includes(type))
                  .map((type) => S.documentTypeListItem(type))
              )
          )
      )
    );
